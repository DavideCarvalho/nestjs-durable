import type {
  Heartbeat,
  RemoteTask,
  RunConsumerOptions,
  RunDispatch,
  RunQueueOptions,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import {
  InMemoryRunQueue,
  InMemoryStateStore,
  RemoteWorkflowExecutor,
  WorkflowEngine,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';
import { WorkflowWorker } from './workflow-worker';

// A `ctx.step` with a retry policy whose attempt fails is retried after its backoff, up to its
// `retries`, whether the run's turns run inline or are dispatched to a workflow worker, and whether
// due runs are handed to the transport's run queue or resumed by the instance that polled. With the
// lost-dispatch self-heal on (`remoteRedispatchMs`), every dispatched step carries that lease in its
// `wakeAt`: a failed attempt waits its backoff, not the lease, while a step whose result never comes
// is still dispatched again once the lease has passed.

/** The lost-dispatch lease, far longer than any backoff below. */
const REDISPATCH_MS = 600_000;

type Handler = (input: unknown) => Promise<unknown>;

/** Workflow turns to an in-app worker, step tasks to handlers, runs through an optional run queue. */
class LoopbackTransport implements Transport {
  private decisionHandler: ((decision: WorkflowDecision) => Promise<void>) | undefined;
  private resultHandler: ((result: StepResult) => Promise<void>) | undefined;
  private engine: WorkflowEngine | undefined;
  readonly handlers = new Map<string, Handler>();
  /** Dispatches whose result is lost (the worker died with the job): counted down per dispatch. */
  dropResults = 0;
  /** Holds the next dispatch's result until it resolves (a step still running on its worker). */
  holdNext: Promise<void> | undefined;
  turns = 0;
  dispatchRuns?: (runs: readonly RunDispatch[], opts?: RunQueueOptions) => Promise<void>;
  onDispatchedRun?: (
    handler: (run: RunDispatch) => Promise<void>,
    opts: RunConsumerOptions,
  ) => () => Promise<void>;

  constructor(
    private readonly worker: WorkflowWorker,
    queue?: Transport,
  ) {
    if (queue) {
      this.dispatchRuns = queue.dispatchRuns?.bind(queue);
      this.onDispatchedRun = queue.onDispatchedRun?.bind(queue);
    }
  }

  attach(engine: WorkflowEngine): void {
    this.engine = engine;
  }

  async dispatch(task: RemoteTask): Promise<void> {
    if (this.dropResults > 0) {
      this.dropResults -= 1;
      return;
    }
    const held = this.holdNext;
    if (held) {
      this.holdNext = undefined;
      void held.then(async () => {
        const result = await runStepHandler(task, this.handlers.get(task.name));
        await this.resultHandler?.(result);
      });
      return;
    }
    const result = await runStepHandler(task, this.handlers.get(task.name));
    setImmediate(() => void this.resultHandler?.(result));
  }
  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.resultHandler = handler;
  }
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.turns += 1;
    if (!this.worker.handles(task.workflow)) {
      const body = this.engine?.workflowBody(task.workflow, task.workflowVersion);
      if (body) this.worker.register(task.workflow, body);
    }
    const decision = await this.worker.processTask(task);
    setImmediate(() => void this.decisionHandler?.(decision));
  }
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = handler;
  }
}

type Body = Parameters<WorkflowEngine['register']>[2];

function app(dispatched: boolean, runQueue: boolean, clock: () => number) {
  const store = new InMemoryStateStore();
  const queue = runQueue ? new InMemoryRunQueue().transport() : undefined;
  const transport = new LoopbackTransport(new WorkflowWorker('app'), queue);
  const engine = new WorkflowEngine({
    store,
    transport,
    clock,
    leaseMs: 30_000,
    remoteAdvanceSilenceMs: 30_000,
    remoteRedispatchMs: REDISPATCH_MS,
  });
  transport.attach(engine);
  if (runQueue) engine.consumeRuns();
  const executor = new RemoteWorkflowExecutor(transport, 'app');
  return {
    store,
    transport,
    engine,
    serve(name: string, body: Body) {
      if (dispatched) engine.register(name, '1', body, { group: 'app', executor });
      else engine.register(name, '1', body);
    },
  };
}

/** Let queued work run: the run queue's batching window is real time. */
async function ticks(n = 40): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 15));
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

/** Advance the clock and poll the due timers until the run settles, at most `steps` times. */
async function drive(
  a: ReturnType<typeof app>,
  runId: string,
  advance: () => void,
  steps = 40,
): Promise<WorkflowRun> {
  for (let i = 0; i < steps; i += 1) {
    await ticks();
    const run = await a.store.getRun(runId);
    if (run?.status === 'completed' || run?.status === 'failed' || run?.status === 'dead') {
      return run;
    }
    advance();
    await a.engine.resumeDueTimers();
  }
  return (await a.store.getRun(runId)) as WorkflowRun;
}

describe.each([
  ['dispatched turns, run queue', true, true],
  ['dispatched turns, no run queue', true, false],
  ['inline turns, run queue', false, true],
  ['inline turns, no run queue', false, false],
])('a ctx.step with retries whose attempt fails (%s)', (_label, dispatched, runQueue) => {
  it('is retried after its backoff and the run completes on the third attempt', async () => {
    let now = 1_000_000;
    const a = app(dispatched, runQueue, () => now);
    let attempts = 0;
    a.transport.handlers.set('ext.flaky', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`wedged ${attempts}`);
      return 'ok';
    });
    a.serve('wf', async (ctx) =>
      ctx.step<string>('ext.flaky', {}, { retries: 3, backoff: 'exp', backoffMs: 1_000 }),
    );

    const startedAt = now;
    await a.engine.start('wf', {}, 'r1');
    await ticks();
    // The first attempt failed: its retry waits the backoff, not the lost-dispatch lease.
    const failed = await a.store.getCheckpoint('r1', 0);
    expect(failed?.status).toBe('failed');
    if (failed?.wakeAt != null) expect(failed.wakeAt).toBeLessThan(startedAt + 10_000);
    const run = await a.store.getRun('r1');
    if (run?.wakeAt != null) expect(run.wakeAt).toBeLessThan(startedAt + 10_000);
    // 5 s at a time, 30 times: well short of the 600 s lease.
    const done = await drive(
      a,
      'r1',
      () => {
        now += 5_000;
      },
      30,
    );
    expect(done.status).toBe('completed');
    expect(done.output).toBe('ok');
    expect(attempts).toBe(3);
    const cp = await a.store.getCheckpoint('r1', 0);
    expect(cp?.attempts).toBe(3);
    if (dispatched) expect(a.transport.turns).toBeGreaterThan(1);
  });

  it('fails the run with the last error once `retries` attempts all failed', async () => {
    let now = 2_000_000;
    const a = app(dispatched, runQueue, () => now);
    let attempts = 0;
    a.transport.handlers.set('ext.down', async () => {
      attempts += 1;
      throw new Error(`down ${attempts}`);
    });
    a.serve('wf', async (ctx) =>
      ctx.step<string>('ext.down', {}, { retries: 3, backoff: 'exp', backoffMs: 1_000 }),
    );

    await a.engine.start('wf', {}, 'r2');
    const done = await drive(
      a,
      'r2',
      () => {
        now += 5_000;
      },
      30,
    );
    expect(done.status).toBe('failed');
    expect(done.error?.message).toContain('down 3');
    expect(attempts).toBe(3);
    expect((await a.store.getCheckpoint('r2', 0))?.attempts).toBe(3);
  });

  it('completes a step whose first attempt succeeds, without waiting on the lease', async () => {
    const now = 3_000_000;
    const a = app(dispatched, runQueue, () => now);
    a.transport.handlers.set('ext.ok', async () => 'fine');
    a.serve('wf', async (ctx) =>
      ctx.step<string>('ext.ok', {}, { retries: 3, backoff: 'exp', backoffMs: 1_000 }),
    );
    await a.engine.start('wf', {}, 'r3');
    const done = await drive(a, 'r3', () => {}, 5);
    expect(done.status).toBe('completed');
    expect(done.output).toBe('fine');
    expect((await a.store.getCheckpoint('r3', 0))?.attempts).toBe(1);
  });

  it('still dispatches again a step whose result never came, once the lease has passed', async () => {
    let now = 4_000_000;
    const a = app(dispatched, runQueue, () => now);
    let attempts = 0;
    a.transport.dropResults = 1;
    a.transport.handlers.set('ext.lost', async () => {
      attempts += 1;
      return 'recovered';
    });
    a.serve('wf', async (ctx) =>
      ctx.step<string>('ext.lost', {}, { retries: 3, backoff: 'exp', backoffMs: 1_000 }),
    );
    const startedAt = now;
    await a.engine.start('wf', {}, 'r4');
    await ticks();
    const pending = await a.store.getCheckpoint('r4', 0);
    expect(pending?.status).toBe('pending');
    // A dispatched turn parks the step on its lease; an inline one keeps its own lease in memory.
    if (dispatched) expect(pending?.wakeAt).toBe(startedAt + REDISPATCH_MS);
    const done = await drive(
      a,
      'r4',
      () => {
        now += 60_000;
      },
      20,
    );
    expect(done.status).toBe('completed');
    expect(done.output).toBe('recovered');
    expect(attempts).toBe(1);
    expect((await a.store.getCheckpoint('r4', 0))?.attempts).toBe(2);
    expect(now).toBeGreaterThanOrEqual(startedAt + REDISPATCH_MS);
  });

  it('waits its backoff even when a replay stamped the lease while the attempt was in flight', async () => {
    let now = 5_000_000;
    const a = app(dispatched, runQueue, () => now);
    let release!: () => void;
    a.transport.holdNext = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    a.transport.handlers.set('ext.slow', async () => {
      attempts += 1;
      if (attempts < 2) throw new Error(`wedged ${attempts}`);
      return 'ok';
    });
    a.serve('wf', async (ctx) =>
      ctx.step<string>('ext.slow', {}, { retries: 3, backoff: 'exp', backoffMs: 1_000 }),
    );
    const startedAt = now;
    await a.engine.start('wf', {}, 'r5');
    await ticks();
    // A replay while the step is still running: the run's turn sees it pending and its lease is
    // stamped (inline: by the replay itself; dispatched: at dispatch).
    now += 1_000;
    await a.engine.resume('r5');
    await ticks();
    const pending = await a.store.getCheckpoint('r5', 0);
    expect(pending?.status).toBe('pending');
    expect(pending?.wakeAt).toBeGreaterThanOrEqual(startedAt + REDISPATCH_MS);
    // The attempt fails now: its retry waits the backoff, not the lease the replay stamped.
    release();
    await ticks();
    const failed = await a.store.getCheckpoint('r5', 0);
    expect(failed?.status).toBe('failed');
    if (failed?.wakeAt != null) expect(failed.wakeAt).toBeLessThan(startedAt + 10_000);
    const done = await drive(
      a,
      'r5',
      () => {
        now += 5_000;
      },
      30,
    );
    expect(done.status).toBe('completed');
    expect(attempts).toBe(2);
  });
});
