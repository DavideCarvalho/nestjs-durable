import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { EngineEvent, RunQuery, WorkflowRun } from './interfaces';
import {
  LIFECYCLE_COALESCED_TAG_PREFIX,
  LIFECYCLE_HEAL_WINDOW_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_REGISTRY_TAG,
  LIFECYCLE_REGISTRY_WORKFLOW,
  LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX,
  lifecycleRegistryRunId,
  runCompletedEvent,
} from './lifecycle-events';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function poll(fn: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;
const triggered = (subscriber: string) => `durable:triggered:${subscriber}`;
const coalesced = (subscriber: string) => `${LIFECYCLE_COALESCED_TAG_PREFIX}${subscriber}`;

/** A store whose lifecycle registry reads can be held back or made to fail. */
class RegistryGatedStore extends InMemoryStateStore {
  gate: Promise<void> | undefined;
  fail = false;
  registryReads = 0;

  override async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    if (query.workflow === LIFECYCLE_REGISTRY_WORKFLOW) {
      this.registryReads += 1;
      if (this.gate) await this.gate;
      if (this.fail) throw new Error('registry read failed');
    }
    return super.listRuns(query);
  }
}

function settledRun(id: string, updatedAt: number): WorkflowRun {
  return {
    id,
    workflow: 'ingest',
    workflowVersion: '1',
    status: 'completed',
    input: {},
    output: 'ok',
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
  };
}

describe('a run that settles before its owed set is known', () => {
  it('settles before the first read of the fleet, then owes the announced subscriber', async () => {
    const store = new RegistryGatedStore();
    const b = new WorkflowEngine({ store, instanceId: 'b' });
    b.register('remote-sub', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await b.heartbeatLifecycleRegistry();

    let release!: () => void;
    store.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    a.register('ingest', '1', async () => 'ok');

    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG]);

    store.gate = undefined;
    release();
    await poll(async () => ((await store.getRun('i1'))?.tags ?? []).includes(owed('remote-sub')));
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('remote-sub')]);

    expect(await b.sweepLifecycleEvents(Date.now() + 60_000)).toBe(1);
    await poll(async () => (await store.getRun('evt:i1:completed:remote-sub')) !== null);
    expect((await store.getRun('i1'))?.tags).toEqual([triggered('remote-sub')]);
  });

  it('settles while the fleet read fails: starts its own subscriber, then resolves the rest', async () => {
    const store = new RegistryGatedStore();
    let now = Date.now();
    const clock = () => now;
    const runs = { mine: 0, theirs: 0 };
    const b = new WorkflowEngine({ store, instanceId: 'b', clock });
    b.register('theirs', '1', async () => void runs.theirs++, {
      onEvent: [runCompletedEvent('ingest')],
    });
    await b.heartbeatLifecycleRegistry();
    const a = new WorkflowEngine({ store, instanceId: 'a', clock });
    a.register('ingest', '1', async () => 'ok');
    a.register('mine', '1', async () => void runs.mine++, {
      onEvent: [runCompletedEvent('ingest')],
    });

    store.fail = true;
    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('evt:i1:completed:mine'))?.status === 'completed');
    await poll(async () => ((await store.getRun('i1'))?.tags ?? []).includes(triggered('mine')));
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, triggered('mine')]);

    store.fail = false;
    now += 60_000;
    await b.heartbeatLifecycleRegistry();
    await a.sweepLifecycleEvents(now);
    expect((await store.getRun('i1'))?.tags).toEqual([
      LIFECYCLE_PENDING_TAG,
      triggered('mine'),
      owed('theirs'),
    ]);

    expect(await b.sweepLifecycleEvents(now)).toBe(1);
    await poll(async () => (await store.getRun('evt:i1:completed:theirs'))?.status === 'completed');
    expect((await store.getRun('i1'))?.tags).toEqual([triggered('mine'), triggered('theirs')]);
    expect(runs).toEqual({ mine: 1, theirs: 1 });
  });

  it('heals a run that settled 5s before a subscriber was announced', async () => {
    const store = new InMemoryStateStore();
    let now = Date.now();
    const clock = () => now;
    const a = new WorkflowEngine({ store, instanceId: 'a', clock });
    a.register('ingest', '1', async () => 'ok');
    await a.sweepLifecycleEvents(now);

    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    expect((await store.getRun('i1'))?.tags ?? []).toEqual([]);

    now += 5_000;
    const b = new WorkflowEngine({ store, instanceId: 'b', clock });
    b.register('late', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await b.heartbeatLifecycleRegistry();

    now += 30_000;
    await a.sweepLifecycleEvents(now);
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('late')]);

    expect(await b.sweepLifecycleEvents(now)).toBe(1);
    await poll(async () => (await store.getRun('evt:i1:completed:late'))?.status === 'completed');
    expect((await store.getRun('i1'))?.tags).toEqual([triggered('late')]);

    // Healed once: another sweep finds nothing missing.
    expect(await a.sweepLifecycleEvents(now)).toBe(0);
    expect(await b.sweepLifecycleEvents(now)).toBe(0);
  });

  it('heals a subscriber this engine has itself, starting it', async () => {
    const store = new InMemoryStateStore();
    let now = Date.now();
    const clock = () => now;
    const a = new WorkflowEngine({ store, instanceId: 'a', clock });
    a.register('ingest', '1', async () => 'ok');
    await a.sweepLifecycleEvents(now);
    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');

    now += 5_000;
    const b = new WorkflowEngine({ store, instanceId: 'b', clock });
    b.register('late', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    now += 30_000;
    expect(await b.sweepLifecycleEvents(now)).toBe(1);
    await poll(async () => (await store.getRun('evt:i1:completed:late'))?.status === 'completed');
    expect((await store.getRun('i1'))?.tags).toEqual([triggered('late')]);
  });

  it('does not heal a run settled before the heal window; republishLifecycle backfills it', async () => {
    const store = new InMemoryStateStore();
    let now = Date.now();
    const clock = () => now;
    await store.createRun(settledRun('old', now - LIFECYCLE_HEAL_WINDOW_MS - 1_000));
    const b = new WorkflowEngine({ store, instanceId: 'b', clock });
    b.register('late', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });

    now += 30_000;
    expect(await b.sweepLifecycleEvents(now)).toBe(0);
    expect((await store.getRun('old'))?.tags ?? []).toEqual([]);
    expect(await store.getRun('evt:old:completed:late')).toBeNull();

    expect(await b.republishLifecycle({ runId: 'old' })).toEqual({
      runs: 1,
      started: 1,
      failed: [],
    });
    expect(await store.getRun('evt:old:completed:late')).not.toBeNull();
  });

  it('reads a registry of more than 1000 rows whole', async () => {
    const store = new InMemoryStateStore();
    const now = Date.now();
    for (let i = 0; i < 1100; i += 1) {
      const workflow = i === 0 ? 'oldest-sub' : `sub-${i}`;
      await store.createRun({
        id: lifecycleRegistryRunId(`instance-${i}`),
        workflow: LIFECYCLE_REGISTRY_WORKFLOW,
        workflowVersion: '1',
        status: 'completed',
        input: {
          instanceId: `instance-${i}`,
          runtime: 'node',
          engineNamespace: null,
          subscriptions: [{ workflow, events: [runCompletedEvent('ingest')] }],
        },
        tags: [LIFECYCLE_REGISTRY_TAG],
        createdAt: new Date(now - 10_000 + i),
        updatedAt: new Date(now),
      });
    }
    const engine = new WorkflowEngine({ store, clock: () => now });

    const subscribers = await engine.lifecycleSubscribers('ingest', 'completed');
    expect(subscribers).toHaveLength(1100);
    expect(subscribers).toContain('oldest-sub');
  });
});

describe('concurrent lifecycle publishers', () => {
  /** A store that pauses each tag write, so two publishers interleave when nothing serializes them. */
  class SlowTagStore extends InMemoryStateStore {
    override async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
      if (patch.tags && Object.keys(patch).length === 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return super.updateRun(runId, patch);
    }
  }

  it('two publishers with disjoint targets converge, each emitting once', async () => {
    const store = new SlowTagStore();
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    a.register('x', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    const b = new WorkflowEngine({ store, instanceId: 'b' });
    b.register('y', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await a.heartbeatLifecycleRegistry();
    await b.heartbeatLifecycleRegistry();
    const events: EngineEvent[] = [];
    a.subscribe((e) => events.push(e));
    b.subscribe((e) => events.push(e));
    await store.createRun({
      ...settledRun('i1', 0),
      tags: [LIFECYCLE_PENDING_TAG, owed('x'), owed('y')],
    });

    const later = Date.now() + LIFECYCLE_HEAL_WINDOW_MS + 60_000;
    expect(
      (await Promise.all([a.sweepLifecycleEvents(later), b.sweepLifecycleEvents(later)])).sort(),
    ).toEqual([1, 1]);

    expect((await store.getRun('i1'))?.tags?.slice().sort()).toEqual([
      triggered('x'),
      triggered('y'),
    ]);
    const triggeredEvents = events
      .filter((e) => e.type === 'run.triggered' && e.runId === 'i1')
      .map((e) => (e as { name?: string }).name)
      .sort();
    expect(triggeredEvents).toEqual(['x', 'y']);
  });

  it('two publishers of the same subscriber start it and report it once', async () => {
    const store = new SlowTagStore();
    const runs = { x: 0 };
    const engines = ['a', 'b'].map((instanceId) => {
      const engine = new WorkflowEngine({ store, instanceId });
      engine.register('x', '1', async () => void runs.x++, {
        onEvent: [runCompletedEvent('ingest')],
      });
      return engine;
    });
    const events: EngineEvent[] = [];
    for (const engine of engines) engine.subscribe((e) => events.push(e));
    await store.createRun({ ...settledRun('i1', 0), tags: [LIFECYCLE_PENDING_TAG, owed('x')] });

    const later = Date.now() + LIFECYCLE_HEAL_WINDOW_MS + 60_000;
    await Promise.all(engines.map((engine) => engine.sweepLifecycleEvents(later)));
    await poll(async () => (await store.getRun('evt:i1:completed:x'))?.status === 'completed');

    expect((await store.getRun('i1'))?.tags).toEqual([triggered('x')]);
    expect(events.filter((e) => e.type === 'run.triggered' && e.runId === 'i1')).toHaveLength(1);
    expect(runs.x).toBe(1);
  });

  it('a republish waits for a publisher holding the lease, then reports it busy', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('x', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await store.createRun(settledRun('i1', 0));
    await store.tryLockRun('i1', 'someone-else', Date.now() + 60_000, Date.now());

    expect(await engine.republishLifecycle({ runId: 'i1' })).toEqual({
      runs: 1,
      started: 0,
      failed: [
        { runId: 'i1', subscriber: '*', error: 'run i1 is being published elsewhere; try again' },
      ],
    });
    expect(await store.getRun('evt:i1:completed:x')).toBeNull();
  });
});

describe('the heal window', () => {
  it('reads the subscriptions and the runs against the nowMs it is given, not the engine clock', async () => {
    const store = new InMemoryStateStore();
    const start = Date.now();
    let clockNow = start;
    const b = new WorkflowEngine({ store, instanceId: 'b', clock: () => clockNow });
    b.register('late', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await b.sweepLifecycleEvents(start);
    await store.createRun(settledRun('i1', start + 20_000));

    // The engine clock runs well past the heal window; the sweep is handed a time inside it.
    clockNow = start + 10 * 60_000;
    expect(await b.sweepLifecycleEvents(start + 60_000)).toBe(1);
    await poll(async () => (await store.getRun('evt:i1:completed:late')) !== null);
    expect((await store.getRun('i1'))?.tags).toEqual([triggered('late')]);
  });
});

describe('a coalesced delivery', () => {
  type Routable = { accumulators: { route: (...args: unknown[]) => Promise<unknown> } };
  const routes = (engine: WorkflowEngine) =>
    vi.spyOn((engine as unknown as Routable).accumulators, 'route');
  const debounced = (engine: WorkflowEngine) =>
    engine.register('digest', '1', async () => 'ok', {
      onEvent: [runCompletedEvent('ingest')],
      eventBatch: { mode: 'debounce', windowMs: 60_000 },
    });
  const triggeredEvents = (events: EngineEvent[]) =>
    events.filter((e) => e.type === 'run.triggered' && e.runId === 'i1');

  it('is tagged when the live publish routes it, and reported once', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async () => 'ok');
    debounced(engine);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.start('ingest', {}, 'i1');
    await poll(async () => ((await store.getRun('i1'))?.tags ?? []).includes(coalesced('digest')));
    expect((await store.getRun('i1'))?.tags).toEqual([coalesced('digest')]);
    expect(triggeredEvents(events)).toHaveLength(1);
  });

  it('heals a coalescing subscriber once: routed once, one run.triggered, tagged', async () => {
    const store = new InMemoryStateStore();
    const now = Date.now();
    await store.createRun(settledRun('i1', now - 40_000));
    const b = new WorkflowEngine({ store, instanceId: 'b', clock: () => now });
    debounced(b);
    const route = routes(b);
    const events: EngineEvent[] = [];
    b.subscribe((e) => events.push(e));

    expect(await b.sweepLifecycleEvents(now)).toBe(1);
    expect(await b.sweepLifecycleEvents(now)).toBe(0);
    expect(route).toHaveBeenCalledTimes(1);
    expect((await store.getRun('i1'))?.tags).toEqual([coalesced('digest')]);
    expect(triggeredEvents(events)).toEqual([
      expect.objectContaining({ name: 'digest', triggeredRunId: undefined }),
    ]);
  });

  it('is not healed again by an engine that just booted', async () => {
    const store = new InMemoryStateStore();
    const now = Date.now();
    await store.createRun({ ...settledRun('i1', now - 40_000), tags: [coalesced('digest')] });
    const booted = new WorkflowEngine({ store, instanceId: 'booted', clock: () => now });
    debounced(booted);
    const route = routes(booted);
    const events: EngineEvent[] = [];
    booted.subscribe((e) => events.push(e));

    expect(await booted.sweepLifecycleEvents(now)).toBe(0);
    expect(route).not.toHaveBeenCalled();
    expect(triggeredEvents(events)).toHaveLength(0);
  });

  it('is republished to a run carrying its tag only when its start also failed', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    debounced(engine);
    const route = routes(engine);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await store.createRun({ ...settledRun('i1', 0), tags: [coalesced('digest')] });
    await store.createRun({
      ...settledRun('i2', 0),
      tags: [coalesced('digest'), `${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}digest`],
    });

    expect(await engine.republishLifecycle({ runId: 'i1' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
    expect(route).not.toHaveBeenCalled();

    expect(await engine.republishLifecycle({ runId: 'i2' })).toEqual({
      runs: 1,
      started: 1,
      failed: [],
    });
    expect(route).toHaveBeenCalledTimes(1);
    expect((await store.getRun('i2'))?.tags).toEqual([coalesced('digest')]);
    // The run already carried the coalesced tag, so the retry records nothing new.
    expect(events.filter((e) => e.type === 'run.triggered')).toHaveLength(0);
  });
});
