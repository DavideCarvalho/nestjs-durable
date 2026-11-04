import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { EngineEvent, RunQuery, WorkflowRun } from './interfaces';
import {
  LIFECYCLE_ORPHAN_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_REGISTRY_HEARTBEAT_MS,
  LIFECYCLE_REGISTRY_STALE_MS,
  LIFECYCLE_REGISTRY_TAG,
  LIFECYCLE_REGISTRY_TTL_MS,
  LIFECYCLE_REGISTRY_WORKFLOW,
  lifecycleRegistryRunId,
  retentionKeeps,
  runCompletedEvent,
  runFailedEvent,
} from './lifecycle-events';
import { CORE_ORIGIN } from './origin';
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
const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;

function registryRow(instanceId: string, updatedAt: number, workflow: string, events: string[]) {
  return {
    id: lifecycleRegistryRunId(instanceId),
    workflow: LIFECYCLE_REGISTRY_WORKFLOW,
    workflowVersion: '1',
    status: 'completed' as const,
    input: { instanceId, runtime: 'node', subscriptions: [{ workflow, events }] },
    tags: [LIFECYCLE_REGISTRY_TAG],
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
  };
}

describe('lifecycle subscription registry in the state store', () => {
  it('starts each subscriber exactly once across two instances with no transport', async () => {
    const store = new InMemoryStateStore();
    const runs = { x: 0, y: 0 };
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    a.register('ingest', '1', async () => 'ok');
    a.register('x', '1', async () => void runs.x++, { onEvent: [runCompletedEvent('ingest')] });
    const b = new WorkflowEngine({ store, instanceId: 'b' });
    b.register('y', '1', async () => void runs.y++, { onEvent: [runCompletedEvent('ingest')] });
    await a.heartbeatLifecycleRegistry();
    await b.heartbeatLifecycleRegistry();

    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('evt:i1:completed:x'))?.status === 'completed');
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual([
      LIFECYCLE_PENDING_TAG,
      owed('y'),
      'durable:triggered:x',
    ]);
    expect(await a.sweepLifecycleEvents(Date.now() + 60_000)).toBe(0);

    expect(await b.sweepLifecycleEvents(Date.now() + 60_000)).toBe(1);
    await poll(async () => (await store.getRun('evt:i1:completed:y'))?.status === 'completed');
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual([
      'durable:triggered:x',
      'durable:triggered:y',
    ]);
    expect(await a.sweepLifecycleEvents(Date.now() + 60_000)).toBe(0);
    expect(await b.sweepLifecycleEvents(Date.now() + 60_000)).toBe(0);
    expect(runs).toEqual({ x: 1, y: 1 });
  });

  it('keeps one completed registry run per instance, refreshed once per heartbeat interval', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000_000;
    const engine = new WorkflowEngine({ store, instanceId: 'i-1', clock: () => now });
    engine.register('notify', '1', async () => 'ok', {
      onEvent: [runCompletedEvent('ingest'), runFailedEvent('ingest'), 'order.placed'],
    });
    engine.register('audit', '1', async () => 'ok', { onEvent: [runFailedEvent('ingest')] });

    await engine.heartbeatLifecycleRegistry();
    const row = (await store.getRun('__lifecycle_registry:i-1')) as WorkflowRun;
    expect(row).toMatchObject({
      workflow: LIFECYCLE_REGISTRY_WORKFLOW,
      status: 'completed',
      tags: [LIFECYCLE_REGISTRY_TAG],
      origin: CORE_ORIGIN,
      input: {
        instanceId: 'i-1',
        runtime: 'node',
        subscriptions: [
          { workflow: 'audit', events: ['run.failed:ingest'] },
          {
            workflow: 'notify',
            events: ['order.placed', 'run.completed:ingest', 'run.failed:ingest'],
          },
        ],
      },
    });
    expect(row.updatedAt.getTime()).toBe(now);

    now += LIFECYCLE_REGISTRY_HEARTBEAT_MS - 1;
    await engine.heartbeatLifecycleRegistry();
    expect((await store.getRun('__lifecycle_registry:i-1'))?.updatedAt.getTime()).toBe(1_000_000);

    now += 1;
    await engine.heartbeatLifecycleRegistry();
    expect((await store.getRun('__lifecycle_registry:i-1'))?.updatedAt.getTime()).toBe(now);
    expect(await store.listRuns({ workflow: LIFECYCLE_REGISTRY_WORKFLOW })).toHaveLength(1);
  });

  it('recreates its registry run when it was deleted', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000_000;
    const engine = new WorkflowEngine({ store, instanceId: 'i-1', clock: () => now });
    engine.register('notify', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await engine.heartbeatLifecycleRegistry();
    await store.deleteRun('__lifecycle_registry:i-1');

    now += LIFECYCLE_REGISTRY_HEARTBEAT_MS;
    await engine.heartbeatLifecycleRegistry();
    expect((await store.getRun('__lifecycle_registry:i-1'))?.updatedAt.getTime()).toBe(now);
  });

  it('writes nothing for an engine with no subscriptions', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async () => 'ok');
    await engine.sweepLifecycleEvents();
    expect(await store.listRuns({ workflow: LIFECYCLE_REGISTRY_WORKFLOW })).toEqual([]);
  });

  it('counts a registry run as announced only while it is fresh', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000_000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    await store.createRun(registryRow('other', now, 'remote', [runCompletedEvent('ingest')]));

    expect(await engine.lifecycleSubscribers('ingest', 'completed')).toEqual(['remote']);
    now += LIFECYCLE_REGISTRY_TTL_MS + 1;
    expect(await engine.lifecycleSubscribers('ingest', 'completed')).toEqual([]);
  });

  it('reads the registry once per 5s, and a failed read drops no orphan', async () => {
    let now = LIFECYCLE_ORPHAN_MS * 2;
    let reads = 0;
    let fail = false;
    class FlakyStore extends InMemoryStateStore {
      override async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
        if (query.workflow === LIFECYCLE_REGISTRY_WORKFLOW) {
          reads += 1;
          if (fail) throw new Error('db down');
        }
        return super.listRuns(query);
      }
    }
    const store = new FlakyStore();
    const events: EngineEvent[] = [];
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.subscribe((e) => events.push(e));
    await store.createRun(registryRow('other', now, 'remote', [runCompletedEvent('ingest')]));

    expect(await engine.lifecycleSubscribers('ingest', 'completed')).toEqual(['remote']);
    expect(await engine.lifecycleSubscribers('ingest', 'completed')).toEqual(['remote']);
    expect(reads).toBe(1);

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
    fail = true;
    now += 6_000;
    await engine.sweepLifecycleEvents(now);
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('remote')]);
    expect(events.filter((e) => e.type === 'run.trigger_failed')).toEqual([]);
  });

  it('leaves a subscriber a registry run announces to that instance', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async () => 'ok');
    // Served here too (as a remote workflow), but its subscription is the other engine's to apply.
    engine.registerRemote('remote', '1', { group: 'remote' });
    await store.createRun(
      registryRow('other', Date.now(), 'remote', [runCompletedEvent('ingest')]),
    );

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('remote')]);
    expect(await store.getRun('evt:i1:completed:remote')).toBeNull();
  });

  it('deletes registry runs not refreshed for 10 minutes, from any engine', async () => {
    const store = new InMemoryStateStore();
    const now = 100_000_000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    await store.createRun(
      registryRow('gone', now - LIFECYCLE_REGISTRY_STALE_MS - 1, 'x', ['run.completed:a']),
    );
    await store.createRun(registryRow('quiet', now - LIFECYCLE_REGISTRY_TTL_MS - 1, 'y', ['e']));

    await engine.heartbeatLifecycleRegistry();
    expect(
      (await store.listRuns({ workflow: LIFECYCLE_REGISTRY_WORKFLOW })).map((r) => r.id),
    ).toEqual(['__lifecycle_registry:quiet']);
  });

  it('is never pruned by retention, resumed by recovery, or published by the lifecycle sweep', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, instanceId: 'i-1' });
    engine.register('notify', '1', async () => 'ok', {
      onEvent: [runCompletedEvent(LIFECYCLE_REGISTRY_WORKFLOW)],
    });
    await engine.heartbeatLifecycleRegistry();
    const before = await store.getRun('__lifecycle_registry:i-1');
    expect(retentionKeeps(before?.tags)).toBe(true);

    expect(
      await store.pruneTerminalRuns(
        { statuses: ['completed'], maxAge: 0 },
        Date.now() + 60 * 60_000,
        100,
      ),
    ).toBe(0);
    expect(
      await store.pruneTerminalRuns({ statuses: ['completed'], maxCount: 0 }, Date.now(), 100),
    ).toBe(0);
    await engine.recoverIncomplete();
    await engine.resumeDueTimers();
    await engine.sweepTimeouts();
    await engine.sweepLifecycleEvents(Date.now() + LIFECYCLE_ORPHAN_MS * 2);
    await settle();

    expect(await store.getRun('__lifecycle_registry:i-1')).toEqual(before);
    expect(await store.getRun('evt:__lifecycle_registry:i-1:completed:notify')).toBeNull();
  });
});
