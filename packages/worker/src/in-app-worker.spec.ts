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
} from '@dudousxd/nestjs-durable-core';
import { WorkflowWorker } from './workflow-worker';

// ---------------------------------------------------------------------------
// Uniform dispatch (Phase 3): "one app, both roles, own group" over the REAL transport seam.
//
// The Phase-2 spec (packages/core/uniform-dispatch.spec) proved a group-served body completes via a
// hand-written in-process executor DOUBLE. This file proves the same end-to-end through the PRODUCTION
// pieces an in-app worker is actually built from:
//
//   engine.register(name, '1', body, { group, executor: new RemoteWorkflowExecutor(transport, group) })
//
// and an in-app `WorkflowWorker` that consumes that group off the SAME transport, fetches the body by
// name via `engine.workflowBody`, replays it, and publishes the `WorkflowDecision` back. The loopback
// transport below stands in for BullMQ: it is the only test double, and it carries the real wire
// objects (`WorkflowTask` out, `WorkflowDecision` back, correlated by `taskId`) exactly as a broker
// would. Swapping it for a real `BullMQTransport` + `runRedisWorker` is the production wiring; the
// engine/worker/executor code under test is identical.
// ---------------------------------------------------------------------------

/**
 * A loopback {@link Transport} that co-locates an engine and a worker in one process: a dispatched
 * {@link WorkflowTask} is handed to an in-app {@link WorkflowWorker} (which lazily fetches the body
 * from the engine by name — "the worker consumes its own engine's group") and the resulting
 * {@link WorkflowDecision} is delivered back on the decision channel, asynchronously, as a real
 * broker would. This is the in-app-worker mechanism the NestJS opt-in wires over BullMQ.
 */
class LoopbackWorkflowTransport implements Transport {
  private decisionHandler: ((decision: WorkflowDecision) => Promise<void>) | undefined;
  /** The co-located engine, attached after construction (the engine needs this transport to be built
   *  first, so the reference is wired in once both exist). */
  private engine: WorkflowEngine | undefined;
  /** Count of dispatched turns, so a test can prove the run went through the transport (not inline). */
  dispatched = 0;

  constructor(private readonly worker: WorkflowWorker) {}

  /** Wire the engine whose group this in-app worker serves (one-time, post-construction). */
  attach(engine: WorkflowEngine): void {
    this.engine = engine;
  }

  // Remote single-steps are not exercised here; a group-served workflow only dispatches WorkflowTasks.
  async dispatch(_task: RemoteTask): Promise<void> {
    throw new Error('LoopbackWorkflowTransport carries workflow tasks only');
  }
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.dispatched += 1;
    // The in-app worker serves its OWN engine's group: if it doesn't yet hold the body, fetch the
    // retained TS body by name (Phase-2 `workflowBody`) and register it. This is exactly how a
    // co-located worker is fed in production — by name, off the same engine.
    if (!this.worker.handles(task.workflow)) {
      const body = this.engine?.workflowBody(task.workflow, task.workflowVersion);
      if (body) this.worker.register(task.workflow, body);
    }
    const decision = await this.worker.processTask(task);
    // Deliver asynchronously: `executor.advance` registers its taskId waiter AFTER this returns, and a
    // real broker is async anyway.
    setImmediate(() => void this.decisionHandler?.(decision));
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = handler;
  }
}

/** Poll the store until `runId` leaves an in-flight state (the executor resolves on a microtask). */
async function settle(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  for (let i = 0; i < 500; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

/** Build a co-located engine + in-app worker on one `group`, wired through one loopback transport —
 *  the production "engine + worker in one app" shape, minus the broker. */
function inAppApp(
  group: string,
  clock?: () => number,
): {
  engine: WorkflowEngine;
  transport: LoopbackWorkflowTransport;
  store: InMemoryStateStore;
  serve(name: string, version: string, body: Parameters<WorkflowEngine['register']>[2]): void;
} {
  const store = new InMemoryStateStore();
  const worker = new WorkflowWorker(group);
  const transport = new LoopbackWorkflowTransport(worker);
  const engine = new WorkflowEngine({
    store,
    transport,
    ...(clock ? { clock } : {}),
  });
  transport.attach(engine);
  const executor = new RemoteWorkflowExecutor(transport, group);
  return {
    engine,
    transport,
    store,
    serve(name, version, body) {
      // Group-served: the engine DISPATCHES this body's turns to `group` (over the transport), and
      // the in-app worker on `group` runs it. The retained body is reachable via `engine.workflowBody`.
      engine.register(name, version, body, { group, executor });
    },
  };
}

describe('in-app worker — engine + worker in one app, own group, real executor + transport', () => {
  it('serves a group-served body end-to-end through the transport and returns its output', async () => {
    const app = inAppApp('app');
    let bodyRuns = 0;
    app.serve('greet', '1', async (ctx, input) => {
      const greeting = await ctx.step('compose', () => {
        bodyRuns += 1;
        return `hello ${input as string}`;
      });
      return { greeting };
    });

    // The engine reports the group it dispatches to, and the body is retained for the in-app worker.
    expect(app.engine.knownGroups()).toEqual(['app']);
    expect(app.engine.workflowBody('greet', '1')).toBeTypeOf('function');

    await app.engine.start('greet', 'davi', 'g1');
    const result = await settle(app.store, 'g1');
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ greeting: 'hello davi' });
    // It went over the transport (dispatched), not inline; the worker ran the body exactly once.
    expect(app.transport.dispatched).toBeGreaterThan(0);
    expect(bodyRuns).toBe(1);
    // The worker's local step is persisted by the engine as a durable, replayable checkpoint.
    const step = (await app.store.listCheckpoints('g1')).find((cp) => cp.seq === 0);
    expect(step?.kind).toBe('local');
    expect(step?.output).toBe('hello davi');
  });

  it('suspends a group-served body on ctx.sleep and resumes it on the timer (body replays once)', async () => {
    let now = 1_000_000;
    const app = inAppApp('app', () => now);
    let stepRuns = 0;
    app.serve('delayed', '1', async (ctx) => {
      const before = await ctx.step('before', () => {
        stepRuns += 1;
        return 'a';
      });
      await ctx.sleep('5ms');
      return { before, after: 'b' };
    });

    await app.engine.start('delayed', null, 'd1');
    // First turn dispatched, recorded `before`, scheduled the timer, suspended. `start` only enqueues
    // (the dispatch model), so wait for the turn to drive the run to its suspend point.
    const suspended = await app.engine.waitForRun('d1');
    expect(suspended.status).toBe('suspended');
    expect((await app.store.getRun('d1'))?.wakeAt).toBe(now + 5);

    now += 1_000_000;
    await app.engine.resumeDueTimers(now);
    const done = await settle(app.store, 'd1');
    expect(done.status).toBe('completed');
    expect(done.output).toEqual({ before: 'a', after: 'b' });
    // Replay across the resume is intact: the pre-sleep step ran exactly once.
    expect(stepRuns).toBe(1);
  });

  it('recovers a crashed group-served run: recoverIncomplete re-drives it via the worker replay', async () => {
    const app = inAppApp('app');
    let firstRuns = 0;
    app.serve('resumable', '1', async (ctx) => {
      const first = await ctx.step('first', () => {
        firstRuns += 1;
        return 1;
      });
      const second = await ctx.step('second', () => 2);
      return { first, second };
    });

    // Orphan a run mid-flight: `running`, with `first` already checkpointed, no live lease.
    const at = new Date();
    await app.store.createRun({
      id: 'r1',
      workflow: 'resumable',
      workflowVersion: '1',
      status: 'running',
      input: null,
      createdAt: at,
      updatedAt: at,
    });
    await app.store.saveCheckpoint({
      runId: 'r1',
      seq: 0,
      name: 'first',
      kind: 'local',
      stepId: 'r1:0',
      status: 'completed',
      output: 1,
      attempts: 1,
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });

    const recovered = await app.engine.recoverIncomplete();
    expect(recovered.some((r) => r.runId === 'r1')).toBe(true);
    const done = await settle(app.store, 'r1');
    expect(done.status).toBe('completed');
    expect(done.output).toEqual({ first: 1, second: 2 });
    // `first` was replayed from history, not re-run — the dispatched recovery path preserves replay.
    expect(firstRuns).toBe(0);
  });

  it('cancels a suspended group-served run (the cascade reaches a dispatched run like any other)', async () => {
    let now = 3_000_000;
    const app = inAppApp('app', () => now);
    app.serve('longsleep', '1', async (ctx) => {
      await ctx.step('mark', () => 'started');
      await ctx.sleep('10s');
      return 'never';
    });

    await app.engine.start('longsleep', null, 'c1');
    expect((await app.engine.waitForRun('c1')).status).toBe('suspended');

    const cancelled = await app.engine.cancel('c1');
    expect(cancelled?.status).toBe('cancelled');
    now += 1_000_000;
    await app.engine.resumeDueTimers(now);
    expect((await app.store.getRun('c1'))?.status).toBe('cancelled');
  });
});
