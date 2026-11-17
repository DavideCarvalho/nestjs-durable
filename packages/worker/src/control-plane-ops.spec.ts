import {
  InMemoryStateStore,
  REMOTE_WORKFLOW_FEATURES,
  type RemoteTask,
  SignalTimeoutError,
  type StepResult,
  type Transport,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowExecutor,
  type WorkflowRun,
  isWorkflowControlFlowSignal,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { StepFailed, toError } from './errors';
import { WorkflowWorker } from './workflow-worker';

/**
 * The control-plane half of the negotiated workflow commands and of the `call` step policy: a real
 * engine applies the decisions a real thin-worker replay produces (an inline `advance` executor, so
 * the engine's clock is the test's), and the run behaves as the same body does in-process.
 */

type Handler = (input: unknown, attempt: number) => unknown;

/** A step transport: runs the registered handler and reports its result; `lose` drops dispatches. */
class StepTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  readonly handlers = new Map<string, Handler>();
  readonly lose = new Set<string>();
  private consumer: ((result: StepResult) => Promise<void>) | undefined;

  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
    if (this.lose.has(task.name)) return;
    const handler = this.handlers.get(task.name);
    setImmediate(async () => {
      const base = { runId: task.runId, seq: task.seq, stepId: task.stepId };
      let result: StepResult;
      try {
        const output = await handler?.(task.input, task.attempt);
        result = { ...base, status: 'completed', output };
      } catch (err) {
        result = { ...base, status: 'failed', error: toError(err) };
      }
      await this.consumer?.(result);
    });
  }
  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.consumer = handler;
  }
  onHeartbeat(): void {}
  attemptsOf(name: string): number[] {
    return this.dispatched.filter((t) => t.name === name).map((t) => t.attempt);
  }
}

function controlPlane(workflows: Record<string, (ctx: WorkflowCtx, input: never) => unknown>) {
  const store = new InMemoryStateStore();
  const transport = new StepTransport();
  let now = Date.parse('2026-11-17T00:00:00.000Z');
  const engine = new WorkflowEngine({ store, transport, clock: () => now, reconcileMs: 0 });
  const worker = new WorkflowWorker();
  for (const [name, fn] of Object.entries(workflows)) {
    worker.register(name, fn as never);
    const executor: WorkflowExecutor = {
      advance: (run: WorkflowRun, history) =>
        worker.processTask({
          taskId: `${run.id}:t`,
          runId: run.id,
          workflow: run.workflow,
          workflowVersion: run.workflowVersion,
          input: run.input,
          history,
          group: name,
          attempt: 1,
          features: [...REMOTE_WORKFLOW_FEATURES],
        }),
    };
    engine.registerRemote(name, '1', { group: name, executor });
  }
  return {
    engine,
    store,
    transport,
    now: () => now,
    /** Move the clock and run the timer poller once. */
    tick: async (ms: number) => {
      now += ms;
      await engine.resumeDueTimers(now);
      await settled();
    },
  };
}

/** Let macrotask re-drives and step results land. An inline turn keeps its lease (30s) after it
 *  suspends, so the timers below are all longer than that: a poll inside it would skip the run. */
async function settled(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 2));
}

async function runOf(engine: WorkflowEngine, id: string): Promise<WorkflowRun | null> {
  await settled();
  return engine.getRun(id);
}

describe('step policy on a remote call, enforced by the control plane', () => {
  it('retries a failed attempt after its backoff, up to `retries`, then completes', async () => {
    const cp = controlPlane({
      pay: async (ctx) => ctx.step('charge', { amount: 5 }, { retries: 3, backoffMs: 60_000 }),
    });
    cp.transport.handlers.set('charge', (_input, attempt) => {
      if (attempt < 3) throw new Error(`flaky ${attempt}`);
      return { ok: attempt };
    });
    await cp.engine.start('pay', {}, 'p1');
    const parked = await runOf(cp.engine, 'p1');
    // Attempt 1 failed: the run waits out the backoff instead of failing.
    expect(parked?.status).toBe('suspended');
    expect(parked?.wakeAt).toBe(cp.now() + 60_000);
    expect(cp.transport.attemptsOf('charge')).toEqual([1]);

    await cp.tick(59_999); // not yet due
    expect(cp.transport.attemptsOf('charge')).toEqual([1]);
    await cp.tick(1);
    expect(cp.transport.attemptsOf('charge')).toEqual([1, 2]);
    await cp.tick(60_000);
    expect(cp.transport.attemptsOf('charge')).toEqual([1, 2, 3]);

    const done = await runOf(cp.engine, 'p1');
    expect(done?.status).toBe('completed');
    expect(done?.output).toEqual({ ok: 3 });
    const checkpoint = (await cp.store.listCheckpoints('p1')).find((c) => c.name === 'charge');
    expect(checkpoint?.attempts).toBe(3);
  });

  it('surfaces the failure to the workflow once the attempts are spent', async () => {
    const cp = controlPlane({
      pay: async (ctx) => {
        try {
          return await ctx.step('charge', {}, { retries: 2 });
        } catch (err) {
          if (isWorkflowControlFlowSignal(err)) throw err;
          return { caught: (err as StepFailed).message };
        }
      },
    });
    cp.transport.handlers.set('charge', () => {
      throw new Error('always');
    });
    await cp.engine.start('pay', {}, 'p1');
    await settled();
    // No backoff: the retry is due at once (the next poll past the turn's lease picks it up).
    await cp.tick(60_000);
    const done = await runOf(cp.engine, 'p1');
    expect(cp.transport.attemptsOf('charge')).toEqual([1, 2]);
    expect(done?.status).toBe('completed');
    expect(done?.output).toEqual({ caught: 'always' });
  });

  it('does not retry an error the worker marked non-retryable', async () => {
    const cp = controlPlane({ pay: async (ctx) => ctx.step('charge', {}, { retries: 5 }) });
    cp.transport.handlers.set('charge', () => {
      throw Object.assign(new Error('declined'), { retryable: false });
    });
    await cp.engine.start('pay', {}, 'p1');
    const done = await runOf(cp.engine, 'p1');
    expect(done?.status).toBe('failed');
    expect(cp.transport.attemptsOf('charge')).toEqual([1]);
  });

  it('re-dispatches an attempt that times out, then fails it with remote_step_timeout', async () => {
    const cp = controlPlane({
      pay: async (ctx) => {
        try {
          return await ctx.step('charge', {}, { retries: 2, timeoutMs: 120_000 });
        } catch (err) {
          if (isWorkflowControlFlowSignal(err)) throw err;
          return { caught: (err as StepFailed).error.code };
        }
      },
    });
    cp.transport.lose.add('charge'); // the worker never answers
    await cp.engine.start('pay', {}, 'p1');
    const parked = await runOf(cp.engine, 'p1');
    expect(parked?.wakeAt).toBe(cp.now() + 120_000);
    await cp.tick(119_999);
    expect(cp.transport.attemptsOf('charge')).toEqual([1]);
    await cp.tick(1);
    expect(cp.transport.attemptsOf('charge')).toEqual([1, 2]);
    await cp.tick(120_000);
    const done = await runOf(cp.engine, 'p1');
    expect(cp.transport.attemptsOf('charge')).toEqual([1, 2]);
    expect(done?.status).toBe('completed');
    expect(done?.output).toEqual({ caught: 'remote_step_timeout' });
  });

  it('a call without a policy keeps the old behaviour: one attempt, failure surfaced', async () => {
    const cp = controlPlane({ pay: async (ctx) => ctx.step('charge', {}) });
    cp.transport.handlers.set('charge', () => {
      throw new Error('once');
    });
    await cp.engine.start('pay', {}, 'p1');
    const done = await runOf(cp.engine, 'p1');
    expect(done?.status).toBe('failed');
    expect(cp.transport.attemptsOf('charge')).toEqual([1]);
  });
});

describe('negotiated ctx commands, applied by the control plane', () => {
  it('sleepUntil parks the run on the absolute deadline', async () => {
    let until = 0;
    const cp = controlPlane({
      nap: async (ctx) => {
        await ctx.sleepUntil(until);
        return 'woke';
      },
    });
    until = cp.now() + 60_000;
    await cp.engine.start('nap', {}, 'n1');
    const parked = await runOf(cp.engine, 'n1');
    expect(parked?.status).toBe('suspended');
    expect(parked?.wakeAt).toBe(until);
    await cp.tick(59_999);
    expect((await cp.engine.getRun('n1'))?.status).toBe('suspended');
    await cp.tick(1);
    expect((await runOf(cp.engine, 'n1'))?.output).toBe('woke');
  });

  const approval = async (ctx: WorkflowCtx) => {
    try {
      return await ctx.waitForSignal<string>('approve', { timeoutMs: 60_000 });
    } catch (err) {
      if (err instanceof SignalTimeoutError) return 'timed-out';
      throw err;
    }
  };

  it('waitForSignal with timeoutMs: the signal wins before the deadline', async () => {
    const cp = controlPlane({ approval });
    await cp.engine.start('approval', {}, 'a1');
    expect((await runOf(cp.engine, 'a1'))?.wakeAt).toBe(cp.now() + 60_000);
    await cp.engine.signal('approve', 'yes');
    expect((await runOf(cp.engine, 'a1'))?.output).toBe('yes');
  });

  it('waitForSignal with timeoutMs: the deadline raises SignalTimeoutError, and a late signal is not delivered to it', async () => {
    const cp = controlPlane({ approval });
    await cp.engine.start('approval', {}, 'a1');
    await settled();
    await cp.tick(60_000);
    const done = await runOf(cp.engine, 'a1');
    expect(done?.status).toBe('completed');
    expect(done?.output).toBe('timed-out');
    expect(await cp.store.listSignalWaiters('approve')).toEqual([]);
  });

  it('waitForEvent: a matching publish resumes the run; a non-matching one does not', async () => {
    const cp = controlPlane({
      paid: async (ctx) => ctx.waitForEvent('order.paid', { match: { id: 7 } }),
    });
    await cp.engine.start('paid', {}, 'e1');
    await settled();
    await cp.engine.publishEvent('order.paid', { id: 8 }, { buffer: false });
    expect((await runOf(cp.engine, 'e1'))?.status).toBe('suspended');
    await cp.engine.publishEvent('order.paid', { id: 7, total: 3 });
    expect((await runOf(cp.engine, 'e1'))?.output).toEqual({ id: 7, total: 3 });
  });

  it('waitForEvent: an event buffered before the wait resolves it at once', async () => {
    const cp = controlPlane({ paid: async (ctx) => ctx.waitForEvent('order.paid') });
    await cp.engine.publishEvent('order.paid', { id: 1 });
    await cp.engine.start('paid', {}, 'e1');
    expect((await runOf(cp.engine, 'e1'))?.output).toEqual({ id: 1 });
  });

  it('waitForEvent with timeoutMs: the deadline raises SignalTimeoutError for event:<name>', async () => {
    const cp = controlPlane({
      paid: async (ctx) => {
        try {
          return await ctx.waitForEvent('order.paid', { timeoutMs: 60_000 });
        } catch (err) {
          if (isWorkflowControlFlowSignal(err)) throw err;
          return (err as SignalTimeoutError).token;
        }
      },
    });
    await cp.engine.start('paid', {}, 'e1');
    await settled();
    await cp.tick(60_000);
    expect((await runOf(cp.engine, 'e1'))?.output).toBe('event:order.paid');
  });

  it('startChild starts the child once, without awaiting it, on the parent partition', async () => {
    const cp = controlPlane({
      parent: async (ctx) => {
        const id = await ctx.startChild('child', { n: 2 }, 'kid-1');
        const done = await ctx.waitForSignal<string>('go');
        return { id, done };
      },
      child: async (_ctx, input: { n: number }) => input.n * 10,
    });
    await cp.engine.start('parent', {}, 'p1', { namespace: 'acme' });
    await settled();
    expect((await cp.engine.getRun('p1'))?.status).toBe('suspended');
    const kid = await runOf(cp.engine, 'kid-1');
    expect(kid?.status).toBe('completed');
    expect(kid?.output).toBe(20);
    expect(kid?.namespace).toBe('acme');
    await cp.engine.signal('go', 'ok');
    expect((await runOf(cp.engine, 'p1'))?.output).toEqual({ id: 'kid-1', done: 'ok' });
    const spawns = (await cp.store.listCheckpoints('p1')).filter((c) => c.name === 'spawn:kid-1');
    expect(spawns).toHaveLength(1);
  });

  it('continueAsNew completes the run and continues on a fresh history', async () => {
    const cp = controlPlane({
      loop: async (ctx, input: { n: number }) => {
        await ctx.sleep(60_000);
        if (input.n < 2) await ctx.continueAsNew({ n: input.n + 1 });
        return input.n;
      },
    });
    await cp.engine.start('loop', { n: 0 }, 'l1');
    await settled();
    await cp.tick(60_000);
    expect((await runOf(cp.engine, 'l1'))?.status).toBe('completed');
    await cp.tick(60_000);
    await cp.tick(60_000);
    const runs = await cp.store.listRuns({});
    const last = runs.find((r) => r.status === 'completed' && r.output === 2);
    expect(last?.id.startsWith('l1~')).toBe(true);
    expect(runs.filter((r) => r.workflow === 'loop')).toHaveLength(3);
  });

  it('setEvent publishes a value engine.getEvent reads while the run is still going', async () => {
    const cp = controlPlane({
      progress: async (ctx) => {
        await ctx.setEvent('pct', 50);
        await ctx.waitForSignal('finish');
        return 'done';
      },
    });
    await cp.engine.start('progress', {}, 's1');
    await settled();
    expect(await cp.engine.getEvent('s1', 'pct')).toBe(50);
  });
});
