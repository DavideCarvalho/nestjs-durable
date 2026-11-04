import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkerDescriptor } from './handshake/index';
import type { EngineEvent, Transport, WorkflowRun } from './interfaces';
import {
  LIFECYCLE_ORPHAN_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  runCompletedEvent,
  triggeredRunsOf,
} from './lifecycle-events';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const settle = () => new Promise((r) => setTimeout(r, 30));

/** A transport whose only job is to serve the live descriptors a fleet advertises. */
function advertising(descriptors: () => WorkerDescriptor[]): Transport {
  return {
    async dispatch(): Promise<void> {},
    onResult(): void {},
    onHeartbeat(): void {},
    async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
      return descriptors();
    },
  };
}

function subscriberWorker(name: string, subscribes: string[]): WorkerDescriptor {
  return {
    instanceId: `worker-${name}`,
    runtime: 'node',
    sdk: { name: 'sdk', version: '1' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [name],
    steps: [],
    registrations: [{ name, subscribes }],
    startedAt: 0,
  };
}

const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;

describe('lifecycle events owed to subscribers the fleet announces', () => {
  it('starts each subscriber exactly once when two instances each have a different one', async () => {
    const store = new InMemoryStateStore();
    const runs = { x: 0, y: 0 };
    const a = new WorkflowEngine({
      store,
      transport: advertising(() => [subscriberWorker('y', [runCompletedEvent('ingest')])]),
    });
    a.register('ingest', '1', async () => 'ok');
    a.register('x', '1', async () => void runs.x++, { onEvent: [runCompletedEvent('ingest')] });
    const b = new WorkflowEngine({ store });
    b.register('y', '1', async () => void runs.y++, { onEvent: [runCompletedEvent('ingest')] });

    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('evt:i1:completed:x'))?.status === 'completed');
    await settle();
    // A published to X live, and the run still owes Y: only B has it.
    expect((await store.getRun('i1'))?.tags).toEqual([
      LIFECYCLE_PENDING_TAG,
      owed('y'),
      'durable:triggered:x',
    ]);
    expect(await a.sweepLifecycleEvents(Date.now() + 60_000)).toBe(0);

    expect(await b.sweepLifecycleEvents(Date.now() + 60_000)).toBe(1);
    await poll(async () => (await store.getRun('evt:i1:completed:y'))?.status === 'completed');
    await settle();
    const settled = (await store.getRun('i1')) as WorkflowRun;
    expect(settled.tags).toEqual(['durable:triggered:x', 'durable:triggered:y']);
    expect(triggeredRunsOf(settled)).toEqual(['evt:i1:completed:x', 'evt:i1:completed:y']);

    expect(await a.sweepLifecycleEvents(Date.now() + 60_000)).toBe(0);
    expect(await b.sweepLifecycleEvents(Date.now() + 60_000)).toBe(0);
    expect(runs).toEqual({ x: 1, y: 1 });
  });

  it('owes the event to a subscriber only the fleet announces, with no local subscriber at all', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport: advertising(() => [subscriberWorker('report', [runCompletedEvent('ingest')])]),
    });
    engine.register('ingest', '1', async () => 'ok');

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();

    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('report')]);
    expect(await engine.lifecycleSubscribers('ingest', 'completed')).toEqual(['report']);
    expect(await engine.lifecycleSubscribers('ingest', 'failed')).toEqual([]);
  });

  it('reads the fleet once per TTL, and a failed read leaves only the local subscribers', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000_000;
    let reads = 0;
    let fail = false;
    const engine = new WorkflowEngine({
      store,
      clock: () => now,
      transport: advertising(() => {
        reads += 1;
        if (fail) throw new Error('redis down');
        return [subscriberWorker('remote', [runCompletedEvent('ingest')])];
      }),
    });
    engine.register('local', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });

    expect(await engine.lifecycleSubscribers('ingest', 'completed')).toEqual(['local', 'remote']);
    expect(await engine.lifecycleSubscribers('ingest', 'completed')).toEqual(['local', 'remote']);
    expect(reads).toBe(1);

    fail = true;
    now += 6_000;
    expect(await engine.lifecycleSubscribers('ingest', 'completed')).toEqual(['local']);
    expect(reads).toBe(2);
  });

  it('drops, after the orphan window, an owed subscriber nobody announces or has', async () => {
    const store = new InMemoryStateStore();
    const events: EngineEvent[] = [];
    const engine = new WorkflowEngine({ store, transport: advertising(() => []) });
    engine.subscribe((e) => events.push(e));
    engine.register('kept', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    const settledAt = 1_000_000;
    await store.createRun({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG, owed('removed'), 'durable:triggered:kept'],
      createdAt: new Date(settledAt),
      updatedAt: new Date(settledAt),
    });

    await engine.sweepLifecycleEvents(settledAt + 60_000);
    expect((await store.getRun('i1'))?.tags).toContain(owed('removed'));

    await engine.sweepLifecycleEvents(settledAt + LIFECYCLE_ORPHAN_MS + 1);
    expect((await store.getRun('i1'))?.tags).toEqual([
      'durable:triggered:kept',
      'durable:trigger_failed:removed',
    ]);
    expect(events.filter((e) => e.type === 'run.trigger_failed')).toEqual([
      expect.objectContaining({
        runId: 'i1',
        name: 'removed',
        error: { message: 'subscriber removed is not registered on any live worker' },
      }),
    ]);
    // `kept` was owed nothing, so it is not started again.
    expect(await store.getRun('evt:i1:completed:kept')).toBeNull();
  });

  it('keeps an owed subscriber past the orphan window while a live worker announces it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport: advertising(() => [subscriberWorker('remote', [runCompletedEvent('ingest')])]),
    });
    await store.createRun({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG, owed('remote')],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    expect(await engine.sweepLifecycleEvents(LIFECYCLE_ORPHAN_MS * 2)).toBe(0);
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('remote')]);
  });

  it('publishes a run marked only pending to every local subscriber', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('a', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    engine.register('b', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await store.createRun({
      id: 'legacy',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    expect(await engine.sweepLifecycleEvents(60_000)).toBe(1);
    await poll(async () => (await store.getRun('evt:legacy:completed:b'))?.status === 'completed');
    expect((await store.getRun('legacy'))?.tags).toEqual([
      'durable:triggered:a',
      'durable:triggered:b',
    ]);
  });

  it('resolves a run marked only pending to nobody when the fleet announces no subscriber', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    await store.createRun({
      id: 'legacy',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    expect(await engine.sweepLifecycleEvents(LIFECYCLE_ORPHAN_MS * 2)).toBe(0);
    expect((await store.getRun('legacy'))?.tags).toEqual([]);
  });
});
