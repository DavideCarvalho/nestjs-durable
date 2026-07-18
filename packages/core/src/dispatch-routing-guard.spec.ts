import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkerDescriptor } from './handshake/descriptor';
import type {
  Heartbeat,
  HistoryEvent,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowCtx,
  WorkflowExecutor,
  WorkflowRun,
} from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * Engine-side capability/protocol routing guard (handshake design §7.5/§7.6). A remote step whose
 * `requires` no live worker can satisfy parks the run `blocked` — no `pending` checkpoint, no dispatch
 * into a queue nobody consumes — and emits the structured diagnostics. When descriptors show a capable
 * worker it dispatches normally; when NO descriptors are published the guard stays disengaged (legacy
 * assume-compatible). The blocked-recovery poll re-drives a blocked run the moment a capable worker
 * appears.
 */

/** A minimal transport that records dispatches and serves a configurable live descriptor fleet. */
class FakeTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  descriptors: WorkerDescriptor[] = [];
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(_h: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}
  async readWorkerDescriptors(_group: string): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
}

/** A worker descriptor advertising `capabilities` under protocol v1 (the current major). */
function worker(id: string, capabilities: string[], range: [number, number] = [1, 1]): WorkerDescriptor {
  return {
    instanceId: id,
    runtime: 'python',
    sdk: { name: 'durable-worker', version: '1' },
    protocol: { version: range[1], range },
    capabilities,
    workflows: [],
    steps: ['Billing.charge'],
    startedAt: 0,
  };
}

/** Register a workflow whose single remote step requires `requires`, run it, and return the run. */
function makeEngine(transport: FakeTransport, clock: () => number = Date.now) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({
    store,
    transport,
    clock,
    blockedPollMs: 5000,
    // Run the body on the caller's turn (deterministic) rather than a background microtask.
    runDispatcher: { dispatch: () => {} },
  });
  engine.register('checkout', '1', async (ctx: WorkflowCtx) => {
    await ctx.step('Billing.charge', { amount: 1 }, { requires: ['search-attr-v2'] });
    return 'ok';
  });
  return { store, engine };
}

describe('routing guard — park blocked when no capable worker (design §7.5)', () => {
  it('parks the run `blocked` with a `capability.unavailable` diagnostics event', async () => {
    const transport = new FakeTransport();
    // A live worker exists on the group, but it does NOT advertise the required capability.
    transport.descriptors = [worker('w1', ['saga', 'signals'])];
    const { store, engine } = makeEngine(transport);
    const events: Array<{ type: string; error?: unknown; diagnostics?: unknown }> = [];
    engine.subscribe((e) => events.push({ type: e.type, error: e.error, diagnostics: e.diagnostics }));

    await engine.start('checkout', {}, 'r1');
    const result = await engine.runOne('r1');

    expect(result?.status).toBe('blocked');
    const run = await store.getRun('r1');
    expect(run?.status).toBe('blocked');
    // The Adonis lesson: a blocked run writes NO `pending` checkpoint (else a re-drive looks
    // dispatched). The store returns null/undefined for an absent checkpoint.
    expect(await store.getCheckpoint('r1', 0)).toBeNull();
    // And it dispatched nothing.
    expect(transport.dispatched).toEqual([]);
    // A `wakeAt` was stamped so the recovery poll re-drives it.
    expect(run?.wakeAt).toBeGreaterThan(0);

    // The loud, structured diagnostics event fired.
    const blocked = events.find((e) => e.type === 'run.blocked');
    expect(blocked).toBeDefined();
    expect((blocked?.error as { code?: string })?.code).toBe('capability.unavailable');
    const diag = blocked?.diagnostics as { code: string; requires: string[]; missingCapabilities?: string[] };
    expect(diag.code).toBe('capability.unavailable');
    expect(diag.requires).toEqual(['search-attr-v2']);
    expect(diag.missingCapabilities).toEqual(['search-attr-v2']);
  });

  it('parks `protocol.incompatible` when the only capable worker speaks a different major', async () => {
    const transport = new FakeTransport();
    // The worker HAS the capability but speaks protocol v2 — the CP speaks v1 → no overlap.
    transport.descriptors = [worker('w2', ['search-attr-v2'], [2, 2])];
    const { store, engine } = makeEngine(transport);
    const events: Array<{ type: string; error?: unknown }> = [];
    engine.subscribe((e) => events.push({ type: e.type, error: e.error }));

    await engine.start('checkout', {}, 'r1');
    const result = await engine.runOne('r1');

    expect(result?.status).toBe('blocked');
    expect((await store.getRun('r1'))?.status).toBe('blocked');
    const blocked = events.find((e) => e.type === 'run.blocked');
    expect((blocked?.error as { code?: string })?.code).toBe('protocol.incompatible');
  });

  it('dispatches normally when a capable + compatible worker is live', async () => {
    const transport = new FakeTransport();
    transport.descriptors = [worker('w3', ['saga', 'search-attr-v2'])];
    const { store, engine } = makeEngine(transport);

    await engine.start('checkout', {}, 'r1');
    const result = await engine.runOne('r1');

    // Routable → the step dispatched and the run suspended awaiting its result (not blocked).
    expect(result?.status).toBe('suspended');
    expect((await store.getRun('r1'))?.status).toBe('suspended');
    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0]?.name).toBe('Billing.charge');
    // The pending checkpoint IS written on the routable path.
    expect((await store.getCheckpoint('r1', 0))?.status).toBe('pending');
  });

  it('LEGACY: no descriptors published → guard skipped, dispatch proceeds (design §7.7)', async () => {
    const transport = new FakeTransport();
    transport.descriptors = []; // pre-handshake fleet — nobody advertises a descriptor
    const { store, engine } = makeEngine(transport);

    await engine.start('checkout', {}, 'r1');
    const result = await engine.runOne('r1');

    expect(result?.status).toBe('suspended');
    expect(transport.dispatched).toHaveLength(1);
    expect((await store.getRun('r1'))?.status).toBe('suspended');
  });
});

describe('blocked-recovery poll re-drives when a capable worker appears (design §7.5)', () => {
  it('a blocked run dispatches the moment a capable worker joins the fleet', async () => {
    const transport = new FakeTransport();
    transport.descriptors = [worker('w1', ['saga'])]; // incapable at first
    let now = 1_000_000;
    const { store, engine } = makeEngine(transport, () => now);

    await engine.start('checkout', {}, 'r1');
    expect((await engine.runOne('r1'))?.status).toBe('blocked');
    expect(transport.dispatched).toEqual([]);

    // Before wakeAt: the poll doesn't re-drive it yet.
    expect(await engine.resumeDueTimers(now)).toEqual([]);

    // A capable worker joins; advance the clock past wakeAt and poll.
    transport.descriptors = [worker('w2', ['search-attr-v2'])];
    now += 6000;
    const resumed = await engine.resumeDueTimers(now);

    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.status).toBe('suspended'); // it dispatched this time
    expect(transport.dispatched).toHaveLength(1);
    expect((await store.getRun('r1'))?.status).toBe('suspended');
  });

  it('stays blocked (re-parks with a fresh wakeAt) while the fleet is still incapable', async () => {
    const transport = new FakeTransport();
    transport.descriptors = [worker('w1', ['saga'])];
    let now = 1_000_000;
    const { store, engine } = makeEngine(transport, () => now);

    await engine.start('checkout', {}, 'r1');
    expect((await engine.runOne('r1'))?.status).toBe('blocked');
    const firstWake = (await store.getRun('r1'))?.wakeAt;

    now += 6000;
    const resumed = await engine.resumeDueTimers(now);
    expect(resumed[0]?.status).toBe('blocked'); // still nobody capable
    expect(transport.dispatched).toEqual([]);
    expect((await store.getRun('r1'))?.wakeAt).toBeGreaterThan(firstWake ?? 0);
  });
});

describe('routing guard — remote workflow turn (design §7.5)', () => {
  /** A dispatch-only executor that records whether the engine handed it a turn to enqueue. */
  class RecordingExecutor implements WorkflowExecutor {
    dispatched = 0;
    async dispatch(_run: WorkflowRun, _history: HistoryEvent[], _taskId: string): Promise<void> {
      this.dispatched += 1;
    }
  }

  it('parks a remote workflow `blocked` before its turn is enqueued when no worker is capable', async () => {
    const transport = new FakeTransport();
    transport.descriptors = [worker('w1', ['saga'])]; // incapable of the required capability
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport, runDispatcher: { dispatch: () => {} } });
    const executor = new RecordingExecutor();
    // Group-served workflow requiring a capability the live worker lacks.
    engine.register('proc', '1', async () => 'unused', {
      group: 'proc',
      executor,
      requires: ['search-attr-v2'],
    });
    const events: string[] = [];
    engine.subscribe((e) => events.push(e.type));

    await engine.start('proc', {}, 'r1');
    const result = await engine.runOne('r1');

    expect(result?.status).toBe('blocked');
    expect((await store.getRun('r1'))?.status).toBe('blocked');
    // The turn was NEVER enqueued to the executor — it parked before dispatch.
    expect(executor.dispatched).toBe(0);
    expect(events).toContain('run.blocked');
  });

  it('dispatches the remote workflow turn when a capable worker is live', async () => {
    const transport = new FakeTransport();
    transport.descriptors = [worker('w2', ['search-attr-v2'])];
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport, runDispatcher: { dispatch: () => {} } });
    const executor = new RecordingExecutor();
    engine.register('proc', '1', async () => 'unused', {
      group: 'proc',
      executor,
      requires: ['search-attr-v2'],
    });

    await engine.start('proc', {}, 'r1');
    const result = await engine.runOne('r1');

    expect(result?.status).toBe('suspended');
    expect(executor.dispatched).toBe(1); // the turn was enqueued
  });
});

describe('routing guard — in-memory (timeoutMs) step path (design §7.5)', () => {
  /** Register a workflow whose remote step has a liveness `timeoutMs` (the `callRemoteInMemory` path). */
  function makeTimeoutEngine(transport: FakeTransport, clock: () => number = Date.now) {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport,
      clock,
      blockedPollMs: 5000,
      runDispatcher: { dispatch: () => {} },
    });
    engine.register('checkout', '1', async (ctx: WorkflowCtx) => {
      // `timeoutMs` diverts to the in-memory liveness path — the one that was previously unguarded.
      await ctx.step('Billing.charge', { amount: 1 }, { requires: ['search-attr-v2'], timeoutMs: 60_000 });
      return 'ok';
    });
    return { store, engine };
  }

  it('parks `blocked` on the timeout path when no capable worker exists (no dispatch into the void)', async () => {
    const transport = new FakeTransport();
    transport.descriptors = [worker('w1', ['saga'])]; // live but incapable
    const { store, engine } = makeTimeoutEngine(transport);
    const events: Array<{ type: string; error?: unknown }> = [];
    engine.subscribe((e) => events.push({ type: e.type, error: e.error }));

    await engine.start('checkout', {}, 'r1');
    const result = await engine.runOne('r1');

    expect(result?.status).toBe('blocked');
    expect((await store.getRun('r1'))?.status).toBe('blocked');
    // The guard fires BEFORE the in-memory dispatch — nothing was enqueued.
    expect(transport.dispatched).toEqual([]);
    const blocked = events.find((e) => e.type === 'run.blocked');
    expect(blocked).toBeDefined();
    expect((blocked?.error as { code?: string })?.code).toBe('capability.unavailable');
  });

  it('dispatches through the timeout path when a capable + compatible worker is live', async () => {
    const transport = new FakeTransport();
    transport.descriptors = [worker('w2', ['search-attr-v2'])];
    const { engine } = makeTimeoutEngine(transport);

    await engine.start('checkout', {}, 'r1');
    // The in-memory path awaits the worker result in-flight (no result arrives in this test), so drive
    // the run without awaiting completion and assert the guard PASSED — i.e. it actually dispatched.
    void engine.runOne('r1');
    await vi.waitFor(() => expect(transport.dispatched).toHaveLength(1));
    expect(transport.dispatched[0]?.name).toBe('Billing.charge');
  });

  it('a timeout-path blocked run re-drives through the SAME recovery (re-parks while incapable)', async () => {
    const transport = new FakeTransport();
    transport.descriptors = [worker('w1', ['saga'])];
    let now = 1_000_000;
    const { store, engine } = makeTimeoutEngine(transport, () => now);

    await engine.start('checkout', {}, 'r1');
    expect((await engine.runOne('r1'))?.status).toBe('blocked');
    const firstWake = (await store.getRun('r1'))?.wakeAt;

    // The blocked-recovery poll (dueBlockedRuns) picks it up regardless of which dispatch path blocked it.
    now += 6000;
    const resumed = await engine.resumeDueTimers(now);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.status).toBe('blocked'); // still nobody capable → re-parks
    expect(transport.dispatched).toEqual([]);
    expect((await store.getRun('r1'))?.wakeAt).toBeGreaterThan(firstWake ?? 0);
  });
});
