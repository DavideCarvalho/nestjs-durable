import type {
  Heartbeat,
  RemoteTask,
  StepCheckpoint,
  StepResult,
  Transport,
  WorkflowCtx,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import {
  FatalError,
  InMemoryStateStore,
  RemoteWorkflowExecutor,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { WorkflowWorker } from './workflow-worker';

// `ctx.localStep(name, fn, { retries, backoff…, compensate })` must behave the same whether the
// engine runs the body in-process or dispatches its turns to a worker. Each case below runs ONE body
// on both runtimes and compares what a consumer sees: the returned value, how many times the body ran,
// the run's error (code + details) and the failed step's checkpoint `attempts`.

/** A loopback transport: dispatched workflow turns run on an in-app {@link WorkflowWorker}. */
class LoopbackWorkflowTransport implements Transport {
  private decisionHandler: ((decision: WorkflowDecision) => Promise<void>) | undefined;
  private engine: WorkflowEngine | undefined;
  dispatched = 0;

  constructor(private readonly worker: WorkflowWorker) {}

  attach(engine: WorkflowEngine): void {
    this.engine = engine;
  }
  async dispatch(_task: RemoteTask): Promise<void> {
    throw new Error('workflow tasks only');
  }
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.dispatched += 1;
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

type Body = (ctx: WorkflowCtx, input: unknown) => Promise<unknown>;
type Outcome = { run: WorkflowRun; checkpoints: StepCheckpoint[]; dispatched: number };

/** Wait for the run to settle; when it parks on a signal, deliver `signal` (once) to resume it. */
async function settle(
  engine: WorkflowEngine,
  store: InMemoryStateStore,
  runId: string,
  signal?: string,
): Promise<WorkflowRun> {
  let pendingSignal = signal;
  for (let i = 0; i < 2000; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const run = await store.getRun(runId);
    if (run?.status === 'suspended' && pendingSignal !== undefined) {
      await engine.signal(pendingSignal, null);
      pendingSignal = undefined;
      continue;
    }
    if (run && !['running', 'suspended', 'pending'].includes(run.status)) return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

/** Run `body` in-process on the engine. */
async function inline(body: Body, signal?: string): Promise<Outcome> {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('wf', '1', body);
  await engine.start('wf', null, 'r1');
  const run = await settle(engine, store, 'r1', signal);
  return { run, checkpoints: await store.listCheckpoints('r1'), dispatched: 0 };
}

/** Run `body` with its turns dispatched to an in-app worker. */
async function dispatched(body: Body, signal?: string): Promise<Outcome> {
  const store = new InMemoryStateStore();
  const worker = new WorkflowWorker('app');
  const transport = new LoopbackWorkflowTransport(worker);
  const engine = new WorkflowEngine({ store, transport });
  transport.attach(engine);
  engine.register('wf', '1', body, {
    group: 'app',
    executor: new RemoteWorkflowExecutor(transport, 'app'),
  });
  await engine.start('wf', null, 'r1');
  const run = await settle(engine, store, 'r1', signal);
  return { run, checkpoints: await store.listCheckpoints('r1'), dispatched: transport.dispatched };
}

const runtimes = { inline, dispatched } as const;

/** An error shaped like a consumer's retryable failure: a code, and the attempt it failed on. */
class AttemptError extends Error {
  readonly code = 'flaky';
  readonly details: { attempt: number };
  constructor(attempt: number) {
    super(`failed on attempt ${attempt}`);
    this.details = { attempt };
  }
}

describe('ctx.localStep options on the worker runtime match the inline engine', () => {
  for (const [label, run] of Object.entries(runtimes)) {
    describe(label, () => {
      it('retries a local step that fails twice, then returns its value', async () => {
        let calls = 0;
        const out = await run(async (ctx) => {
          return ctx.localStep(
            'flaky',
            async () => {
              calls += 1;
              if (calls < 3) throw new AttemptError(calls);
              return `ok after ${calls}`;
            },
            { retries: 3, backoff: 'exp', backoffMs: 5 },
          );
        });
        if (label === 'dispatched') expect(out.dispatched).toBeGreaterThan(0);
        expect(out.run.status).toBe('completed');
        expect(out.run.output).toBe('ok after 3');
        expect(calls).toBe(3);
        const cp = out.checkpoints.find((c) => c.name === 'flaky');
        expect(cp?.status).toBe('completed');
        expect(cp?.attempts).toBe(3);
      });

      it('waits the backoff between attempts', async () => {
        const at: number[] = [];
        await run(async (ctx) =>
          ctx.localStep(
            'spaced',
            async () => {
              at.push(Date.now());
              if (at.length < 3) throw new Error('again');
              return 1;
            },
            { retries: 3, backoff: 'exp', backoffMs: 20 },
          ),
        );
        expect(at).toHaveLength(3);
        // exp: 20ms after attempt 1, 40ms after attempt 2 (setTimeout may fire a hair early).
        expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(18);
        expect((at[2] as number) - (at[1] as number)).toBeGreaterThanOrEqual(38);
      });

      it('ends after `retries` attempts with the last attempt’s code and details', async () => {
        let calls = 0;
        const out = await run(async (ctx) =>
          ctx.localStep(
            'doomed',
            async () => {
              calls += 1;
              throw new AttemptError(calls);
            },
            { retries: 3, backoffMs: 1 },
          ),
        );
        expect(calls).toBe(3);
        expect(out.run.status).toBe('failed');
        expect(out.run.error?.message).toBe('failed on attempt 3');
        expect(out.run.error?.code).toBe('flaky');
        expect(out.run.error?.details).toEqual({ attempt: 3 });
        const cp = out.checkpoints.find((c) => c.name === 'doomed');
        expect(cp?.status).toBe('failed');
        expect(cp?.attempts).toBe(3);
        expect(cp?.error?.details).toEqual({ attempt: 3 });
      });

      it('does not retry a FatalError', async () => {
        let calls = 0;
        const out = await run(async (ctx) =>
          ctx.localStep(
            'fatal',
            async () => {
              calls += 1;
              throw new FatalError('no point', 'declined', { attempt: calls });
            },
            { retries: 5, backoffMs: 1 },
          ),
        );
        expect(calls).toBe(1);
        expect(out.run.status).toBe('failed');
        expect(out.run.error?.code).toBe('declined');
        expect(out.run.error?.details).toEqual({ attempt: 1 });
        expect(out.checkpoints.find((c) => c.name === 'fatal')?.attempts).toBe(1);
      });

      it('runs compensations in reverse when a later step fails, keeping the original error', async () => {
        const undone: string[] = [];
        const out = await run(async (ctx) => {
          await ctx.localStep('reserve', async () => 'r', {
            compensate: async () => void undone.push('reserve'),
          });
          await ctx.localStep('hold', async () => 'h', {
            compensate: async () => void undone.push('hold'),
          });
          await ctx.localStep('charge', async () => {
            throw new Error('declined');
          });
        });
        expect(undone).toEqual(['hold', 'reserve']);
        expect(out.run.status).toBe('failed');
        expect(out.run.error?.message).toBe('declined');
        const undos = out.checkpoints
          .filter((c) => c.name.startsWith('compensate:'))
          .sort((a, b) => b.seq - a.seq)
          .map((c) => [c.name, c.status, c.seq]);
        expect(undos).toEqual([
          ['compensate:hold', 'completed', -1],
          ['compensate:reserve', 'completed', -2],
        ]);
      });

      it('registers a step’s compensation when it completed in an earlier turn', async () => {
        const undone: string[] = [];
        const out = await run(async (ctx) => {
          await ctx.localStep('reserve', async () => 'r', {
            compensate: async () => void undone.push('reserve'),
          });
          await ctx.waitForSignal('go');
          await ctx.localStep('charge', async () => {
            throw new Error('declined');
          });
        }, 'go');
        expect(out.run.status).toBe('failed');
        expect(undone).toEqual(['reserve']);
      });

      it('records a compensation that keeps failing and does not mask the original error', async () => {
        const out = await run(async (ctx) => {
          await ctx.localStep('reserve', async () => 'r', {
            compensate: async () => {
              throw new Error('refund down');
            },
          });
          await ctx.localStep('charge', async () => {
            throw new Error('declined');
          });
        });
        expect(out.run.error?.message).toBe('declined');
        const undo = out.checkpoints.find((c) => c.name === 'compensate:reserve');
        expect(undo?.status).toBe('failed');
        expect(undo?.error?.message).toBe('refund down');
      });

      it('does not retry a workflow primitive called inside the step body', async () => {
        let calls = 0;
        const out = await run(async (ctx) =>
          ctx.localStep(
            'nested',
            async () => {
              calls += 1;
              await ctx.sideEffect(() => 1);
            },
            { retries: 4, backoffMs: 1 },
          ),
        );
        expect(calls).toBe(1);
        expect(out.run.status).toBe('failed');
        expect(out.run.error?.code).toBe('nested_workflow_call');
      });
    });
  }
});

describe('worker saga unwind', () => {
  function task(history: WorkflowTask['history'] = []): WorkflowTask {
    return {
      taskId: 't1',
      runId: 'r1',
      workflow: 'saga',
      workflowVersion: '1',
      input: null,
      history,
      pendingSignals: [],
      group: 'saga',
      attempt: 1,
    };
  }

  it('skips an undo the history already records', async () => {
    let undone = 0;
    const worker = new WorkflowWorker();
    worker.register('saga', async (ctx) => {
      await ctx.localStep('reserve', async () => 'r', {
        compensate: async () => {
          undone += 1;
        },
      });
      await ctx.localStep('charge', async () => {
        throw new Error('declined');
      });
    });
    const decision = await worker.processTask(
      task([
        { seq: 0, kind: 'step', name: 'reserve', output: 'r' },
        { seq: 1, kind: 'step', name: 'charge', error: { message: 'declined' } },
        { seq: -1, kind: 'step', name: 'compensate:reserve', output: null },
      ]),
    );
    expect(decision.status).toBe('failed');
    expect(decision.error?.message).toBe('declined');
    expect(undone).toBe(0);
    expect(decision.commands.filter((c) => c.seq < 0)).toEqual([]);
  });

  it('tries an undo up to compensationRetries times and records the attempts', async () => {
    let tries = 0;
    const worker = new WorkflowWorker('workflows', { compensationRetries: 3 });
    worker.register('saga', async (ctx) => {
      await ctx.localStep('reserve', async () => 'r', {
        compensate: async () => {
          tries += 1;
          if (tries < 3) throw new Error('refund hiccup');
        },
      });
      await ctx.localStep('charge', async () => {
        throw new Error('declined');
      });
    });
    const decision = await worker.processTask(task());
    expect(decision.status).toBe('failed');
    expect(tries).toBe(3);
    const undo = decision.commands.find((c) => c.seq === -1);
    expect(undo).toMatchObject({ kind: 'recordStep', name: 'compensate:reserve', attempts: 3 });
    expect(undo).not.toHaveProperty('error');
  });
});
