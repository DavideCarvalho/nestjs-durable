import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type {
  HistoryEvent,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
  WorkflowTask,
} from './interfaces';
import { RemoteWorkflowExecutor } from './remote-workflow-executor';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const PING_STEP_NAME = 'ext.ping';

/** A recording transport that captures every dispatched task and immediately delivers a completed
 *  result for it — so both the durable suspend path and the in-memory heartbeat path settle. */
function recordingTransport(dispatched: RemoteTask[]): Transport {
  let onResult: ((r: StepResult) => Promise<void>) | undefined;
  return {
    async dispatch(task) {
      dispatched.push(task);
      const result: StepResult = {
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output: { pong: true },
      };
      // Deliver async, mirroring a real broker (a durable call suspends right after dispatch).
      setImmediate(() => void onResult?.(result));
    },
    onResult(handler) {
      onResult = handler;
    },
    onHeartbeat() {},
  };
}

/** Stand-in for a polyglot (e.g. Python) workflow that issues a single remote `call` command —
 *  this is the executor-driven dispatch site (`cmd.kind === 'call'`), distinct from `ctx.call`. */
function callExecutor(): WorkflowExecutor {
  return {
    async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
      const bySeq = new Map(history.map((e) => [e.seq, e]));
      const base = { taskId: 'task', runId: run.id } as const;
      if (!bySeq.has(0)) {
        return {
          ...base,
          status: 'continue',
          commands: [{ kind: 'call', seq: 0, name: 'ext.ping', group: 'ext', input: {} }],
        };
      }
      return { ...base, status: 'completed', commands: [], output: { done: true } };
    },
  };
}

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('context carrier — opaque tenant/user/correlation propagation to workers', () => {
  it('attaches the configured context to dispatched remote tasks', async () => {
    const store = new InMemoryStateStore();
    const dispatched: RemoteTask[] = [];
    const transport: Transport = {
      async dispatch(task) {
        dispatched.push(task);
      },
      onResult(_h: (r: StepResult) => Promise<void>) {},
      onHeartbeat() {},
    };
    const engine = new WorkflowEngine({
      store,
      transport,
      context: () => ({ tenantId: 't1', userRef: { type: 'User', id: 1 } }),
    });
    engine.register('wf', '1', async (ctx) => {
      await ctx.step(PING_STEP_NAME, {});
      return 'x';
    });

    await startRun(engine, 'wf', {}, 'r1');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.context).toEqual({
      tenantId: 't1',
      userRef: { type: 'User', id: 1 },
    });
  });

  it('omits context when no provider is configured, and traceparent still works', async () => {
    const store = new InMemoryStateStore();
    const dispatched: RemoteTask[] = [];
    const transport: Transport = {
      async dispatch(task) {
        dispatched.push(task);
      },
      onResult() {},
      onHeartbeat() {},
    };
    const engine = new WorkflowEngine({
      store,
      transport,
      traceparent: () => '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    engine.register('wf', '1', async (ctx) => {
      await ctx.step(PING_STEP_NAME, {});
      return 'x';
    });

    await startRun(engine, 'wf', {}, 'r1');

    expect(dispatched[0]?.context).toBeUndefined();
    expect(dispatched[0]?.traceparent).toBe(
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
  });

  it('attaches context on the command dispatch path (polyglot `call` command, engine.ts ~1533)', async () => {
    const store = new InMemoryStateStore();
    const dispatched: RemoteTask[] = [];
    const engine = new WorkflowEngine({
      store,
      transport: recordingTransport(dispatched),
      context: () => ({ tenantId: 't2', userRef: { type: 'User', id: 2 } }),
    });
    // A remote (executor-driven) workflow whose advance() emits a `call` command — this is applied by
    // `applyCommands` (cmd.kind === 'call'), a DIFFERENT dispatch site than the native `ctx.call` path.
    engine.registerRemote('pipeline', '1', { group: 'py-workflows', executor: callExecutor() });

    await startRun(engine, 'pipeline', {}, 'cmd1');
    const run = await settle(store, 'cmd1');
    expect(run.status).toBe('completed');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.context).toEqual({ tenantId: 't2', userRef: { type: 'User', id: 2 } });
  });

  // `ctx.step(name, input, opts?)` sets `timeoutMs` per call via `StepDispatchOpts` (see
  // heartbeat.spec.ts / remote-retry.spec.ts for the full writeup), routing this call through the
  // in-memory heartbeat dispatch site (`callRemoteInMemory`, engine.ts).
  it('attaches context on the in-memory heartbeat path (remote step with `timeoutMs`, engine.ts ~2002)', async () => {
    const store = new InMemoryStateStore();
    const dispatched: RemoteTask[] = [];
    const engine = new WorkflowEngine({
      store,
      transport: recordingTransport(dispatched),
      context: () => ({ tenantId: 't3', userRef: { type: 'User', id: 3 } }),
    });
    // A `timeoutMs` step is awaited in-memory (callRemoteInMemory) with a heartbeat window, not via
    // the durable suspend path — a third, distinct dispatch site.
    engine.register('wf', '1', async (ctx) => {
      await ctx.step(PING_STEP_NAME, {}, { timeoutMs: 5000 });
      return 'x';
    });

    const run = await startRun(engine, 'wf', {}, 'hb1');
    expect(run.status).toBe('completed');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.context).toEqual({ tenantId: 't3', userRef: { type: 'User', id: 3 } });
  });
});

describe('context carrier on a dispatched workflow turn', () => {
  /** A transport that carries workflow tasks and step tasks and records both; decisions and step
   *  results are delivered by the test through the captured handlers. */
  function turnTransport() {
    const turns: WorkflowTask[] = [];
    const steps: RemoteTask[] = [];
    const handlers: { decide?: (d: WorkflowDecision) => Promise<void> } = {};
    const transport: Transport = {
      async dispatch(task) {
        steps.push(task);
      },
      onResult() {},
      onHeartbeat() {},
      async dispatchWorkflowTask(task) {
        turns.push(task);
      },
      onDecision(handler) {
        handlers.decide = handler;
      },
    };
    return { transport, turns, steps, handlers };
  }

  /** Start `runId` and wait until its first turn is on the transport (the run then awaits it). */
  async function startTurn(engine: WorkflowEngine, turns: WorkflowTask[], runId: string) {
    await engine.start('ask', {}, runId);
    for (let i = 0; i < 100 && turns.length === 0; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it('stamps the context reader on the dispatched turn, and omits it without a reader', async () => {
    for (const context of [() => ({ traceId: 'trace-1' }), undefined]) {
      const store = new InMemoryStateStore();
      const { transport, turns } = turnTransport();
      const engine = new WorkflowEngine({ store, transport, ...(context ? { context } : {}) });
      const executor = new RemoteWorkflowExecutor(transport, 'ask');
      engine.register('ask', '1', async () => 'x', { group: 'ask', executor });
      await startTurn(engine, turns, 'r1');
      expect(turns).toHaveLength(1);
      expect(turns[0]?.context).toEqual(context ? { traceId: 'trace-1' } : undefined);
      expect(turns[0] !== undefined && 'context' in turns[0]).toBe(context !== undefined);
    }
  });

  /** An engine whose context lives in `als`, with one dispatched turn of run `r1` started inside
   *  `started` (or outside any context when omitted). */
  async function engineWithTurn(
    options: {
      started?: Record<string, unknown>;
      rehydrate?: (carrier: Record<string, unknown> | undefined, fn: () => unknown) => unknown;
      tenancy?: ConstructorParameters<typeof WorkflowEngine>[0]['tenancy'];
      onContext?: () => void;
    } = {},
  ) {
    const als = new AsyncLocalStorage<Record<string, unknown>>();
    const store = new InMemoryStateStore();
    const { transport, turns, steps, handlers } = turnTransport();
    const engine = new WorkflowEngine({
      store,
      transport,
      context: () => {
        options.onContext?.();
        return als.getStore() ?? { traceId: 'fresh' };
      },
      rehydrate: (options.rehydrate ??
        ((carrier, fn) => (carrier ? als.run(carrier, fn) : fn()))) as <T>(
        carrier: Record<string, unknown> | undefined,
        fn: () => T,
      ) => T,
      ...(options.tenancy ? { tenancy: options.tenancy } : {}),
    });
    const executor = new RemoteWorkflowExecutor(transport, 'ask');
    engine.register('ask', '1', async () => 'x', { group: 'ask', executor });
    const start = () => startTurn(engine, turns, 'r1');
    await (options.started ? als.run(options.started, start) : start());
    const taskId = (await store.getRun('r1'))?.awaitingDecisionTaskId as string;
    const decide = (over: Partial<WorkflowDecision> & Record<string, unknown> = {}) =>
      handlers.decide?.({
        taskId,
        runId: 'r1',
        status: 'continue',
        commands: [{ kind: 'call', seq: 0, name: 'probe.run', input: {} }],
        ...over,
      } as WorkflowDecision);
    return { als, store, turns, steps, taskId, decide };
  }

  it("applies a decision under the carrier the engine stamped on that turn, so the turn's steps carry it", async () => {
    const { turns, steps, decide } = await engineWithTurn({ started: { traceId: 'started-with' } });
    expect(turns[0]?.context).toEqual({ traceId: 'started-with' });
    // Outside any context, as a decision consumer runs.
    await decide();
    expect(steps.map((t) => t.context)).toEqual([{ traceId: 'started-with' }]);
  });

  it('never applies a decision under a carrier the worker sends back', async () => {
    const { steps, decide } = await engineWithTurn({ started: { traceId: 'started-with' } });
    await decide({
      context: { traceId: 'forged', tenantId: 'other', userRef: { type: 'u', id: 1 } },
    });
    expect(steps.map((t) => t.context)).toEqual([{ traceId: 'started-with' }]);
  });

  it("applies a decision another instance dispatched under its own context, not the dispatcher's carrier", async () => {
    const { store, taskId } = await engineWithTurn({ started: { traceId: 'started-with' } });
    // A second instance on the same store consumes the decision: it holds no carrier for the turn.
    const other = turnTransport();
    const engine = new WorkflowEngine({
      store,
      transport: other.transport,
      context: () => ({ traceId: 'other-instance' }),
      rehydrate: (_carrier, fn) => fn(),
    });
    const executor = new RemoteWorkflowExecutor(other.transport, 'ask');
    engine.register('ask', '1', async () => 'x', { group: 'ask', executor });
    await other.handlers.decide?.({
      taskId,
      runId: 'r1',
      status: 'continue',
      commands: [{ kind: 'call', seq: 0, name: 'probe.run', input: {} }],
    });
    expect(other.steps.map((t) => t.context)).toEqual([{ traceId: 'other-instance' }]);
  });

  it('logs a carrier the rehydrate bridge rejects and applies the decision without it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { store, steps, decide } = await engineWithTurn({
        started: { traceId: 'started-with' },
        rehydrate: (carrier, fn) => {
          if (carrier?.traceId === 'started-with') throw new Error('malformed carrier');
          return fn();
        },
      });
      await decide();
      expect(steps.map((t) => t.context)).toEqual([{ traceId: 'fresh' }]);
      expect((await store.getRun('r1'))?.status).toBe('suspended');
      expect(warn.mock.calls.flat().join(' ')).toMatch(/r1.*context carrier.*malformed carrier/);
    } finally {
      warn.mockRestore();
    }
  });

  it("applies a decision in the run's tenant", async () => {
    const tenantAls = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const { decide } = await engineWithTurn({
      tenancy: {
        current: () => ({ id: 'acme', kind: 'company' }),
        filter: () => ({ mode: 'all' }),
        run: (tenant, fn) => tenantAls.run(tenant.id, fn),
      },
      onContext: () => seen.push(tenantAls.getStore()),
    });
    seen.length = 0;
    // Outside any tenant, as a decision consumer runs: the step it dispatches sees the run's.
    await decide();
    expect(seen).toEqual(['acme']);
  });
});
