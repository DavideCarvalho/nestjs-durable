import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import {
  InMemoryStateStore,
  RemoteWorkflowExecutor,
  WorkflowEngine,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';
import { WorkflowWorker } from './workflow-worker';

// A failed run that `requeue` redrives must re-run its failed step whether its turns run inline or
// are dispatched to a workflow worker: the history the engine sends the worker must not carry the
// failed attempt the requeue reset, or the worker's replay throws the stored error again.

type Handler = (input: unknown) => Promise<unknown>;

/** One loopback that carries both wires: workflow turns to an in-app worker, step tasks to handlers. */
class LoopbackTransport implements Transport {
  private decisionHandler: ((decision: WorkflowDecision) => Promise<void>) | undefined;
  private resultHandler: ((result: StepResult) => Promise<void>) | undefined;
  private engine: WorkflowEngine | undefined;
  readonly handlers = new Map<string, Handler>();
  turns = 0;

  constructor(private readonly worker: WorkflowWorker) {}

  attach(engine: WorkflowEngine): void {
    this.engine = engine;
  }

  async dispatch(task: RemoteTask): Promise<void> {
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

async function settle(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  for (let i = 0; i < 2000; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

type Body = Parameters<WorkflowEngine['register']>[2];

function app(dispatched: boolean, clock: () => number) {
  const store = new InMemoryStateStore();
  const transport = new LoopbackTransport(new WorkflowWorker('app'));
  const engine = new WorkflowEngine({ store, transport, clock });
  transport.attach(engine);
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

describe.each([
  ['dispatched to the workflow worker', true],
  ['inline', false],
])('requeue of a run failed by an exhausted step (%s)', (_label, dispatched) => {
  it('re-runs the failed step and completes, without re-running the steps before it', async () => {
    let now = 1_000_000;
    const a = app(dispatched, () => now);
    let firstRuns = 0;
    let flakyRuns = 0;
    let healthy = false;
    a.transport.handlers.set('ext.first', async () => {
      firstRuns += 1;
      return 'one';
    });
    a.transport.handlers.set('ext.flaky', async () => {
      flakyRuns += 1;
      if (!healthy) throw new Error('wedged');
      return 'two';
    });
    a.serve('wf', async (ctx) => {
      const first = await ctx.step<string>('ext.first', {});
      const second = await ctx.step<string>('ext.flaky', {}, { retries: 2, backoffMs: 1 });
      return [first, second];
    });

    await a.engine.start('wf', {}, 'r1');
    for (let i = 0; i < 20; i += 1) {
      const run = await a.store.getRun('r1');
      if (run?.status === 'failed') break;
      now += 1_000;
      await a.engine.resumeDueTimers(now);
      for (let j = 0; j < 20; j += 1) await new Promise((r) => setImmediate(r));
    }
    expect((await a.store.getRun('r1'))?.status).toBe('failed');
    expect(flakyRuns).toBe(2);
    expect(firstRuns).toBe(1);

    healthy = true;
    now += 1;
    await a.engine.requeue('r1');
    for (let i = 0; i < 20; i += 1) {
      const run = await a.store.getRun('r1');
      if (run?.status === 'completed' || run?.status === 'failed') break;
      now += 1_000;
      await a.engine.resumeDueTimers(now);
      for (let j = 0; j < 20; j += 1) await new Promise((r) => setImmediate(r));
    }
    const done = await settle(a.store, 'r1');
    expect(done.status).toBe('completed');
    expect(done.output).toEqual(['one', 'two']);
    expect(flakyRuns).toBe(3);
    expect(firstRuns).toBe(1);
    if (dispatched) expect(a.transport.turns).toBeGreaterThan(0);
  });

  it('re-runs a failed step that had no retry policy', async () => {
    let now = 2_000_000;
    const a = app(dispatched, () => now);
    let runs = 0;
    let healthy = false;
    a.transport.handlers.set('ext.once', async () => {
      runs += 1;
      if (!healthy) throw new Error('down');
      return 'ok';
    });
    a.serve('single', async (ctx) => ctx.step<string>('ext.once', {}));

    await a.engine.start('single', {}, 's1');
    expect((await settle(a.store, 's1')).status).toBe('failed');
    expect(runs).toBe(1);

    healthy = true;
    now += 1;
    await a.engine.requeue('s1');
    const done = await settle(a.store, 's1');
    expect(done.status).toBe('completed');
    expect(done.output).toBe('ok');
    expect(runs).toBe(2);
  });
  it('re-runs a failed local step after the completed local step before it', async () => {
    let now = 3_000_000;
    const a = app(dispatched, () => now);
    let firstRuns = 0;
    let flakyRuns = 0;
    let healthy = false;
    a.serve('local', async (ctx) => {
      const first = await ctx.localStep('first', async () => {
        firstRuns += 1;
        return 1;
      });
      const second = await ctx.localStep(
        'flaky',
        async () => {
          flakyRuns += 1;
          if (!healthy) throw new Error('down');
          return 2;
        },
        { retries: 2, backoffMs: 1 },
      );
      return first + second;
    });

    await a.engine.start('local', {}, 'l1');
    expect((await settle(a.store, 'l1')).status).toBe('failed');
    expect(flakyRuns).toBe(2);

    healthy = true;
    now += 1;
    await a.engine.requeue('l1');
    const done = await settle(a.store, 'l1');
    expect(done.status).toBe('completed');
    expect(done.output).toBe(3);
    expect(flakyRuns).toBe(3);
    expect(firstRuns).toBe(1);
  });
  it('keeps a compensated saga consistent: the failed step re-runs, the completed one does not', async () => {
    let now = 4_000_000;
    const a = app(dispatched, () => now);
    let bookRuns = 0;
    let undoRuns = 0;
    let chargeRuns = 0;
    let healthy = false;
    a.serve('saga', async (ctx) => {
      await ctx.localStep(
        'book',
        async () => {
          bookRuns += 1;
          return 'booked';
        },
        {
          compensate: async () => {
            undoRuns += 1;
          },
        },
      );
      return ctx.localStep('charge', async () => {
        chargeRuns += 1;
        if (!healthy) throw new Error('card declined');
        return 'charged';
      });
    });

    await a.engine.start('saga', {}, 'g1');
    expect((await settle(a.store, 'g1')).status).toBe('failed');
    expect(undoRuns).toBe(1);

    healthy = true;
    now += 1;
    await a.engine.requeue('g1');
    const done = await settle(a.store, 'g1');
    expect(done.status).toBe('completed');
    expect(done.output).toBe('charged');
    expect(bookRuns).toBe(1);
    expect(chargeRuns).toBe(2);
    expect(undoRuns).toBe(1);
  });
  it("requeue of the parent re-runs its failed child's step, and the parent completes", async () => {
    let now = 5_000_000;
    const a = app(dispatched, () => now);
    let runs = 0;
    let healthy = false;
    a.transport.handlers.set('ext.child-step', async () => {
      runs += 1;
      if (!healthy) throw new Error('boom');
      return 'child-ok';
    });
    a.serve('child', async (ctx) => ctx.step<string>('ext.child-step', {}));
    a.serve('parent', async (ctx) => `parent saw ${await ctx.child<string>('child', {})}`);

    await a.engine.start('parent', {}, 'p1');
    expect((await settle(a.store, 'p1')).status).toBe('failed');
    expect(runs).toBe(1);

    healthy = true;
    now += 1;
    await a.engine.requeue('p1');
    const done = await settle(a.store, 'p1');
    expect(done.status).toBe('completed');
    expect(done.output).toBe('parent saw child-ok');
    expect(runs).toBe(2);
  });
});
