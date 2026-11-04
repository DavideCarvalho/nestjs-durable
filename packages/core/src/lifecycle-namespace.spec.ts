import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { EngineEvent, WorkflowRun } from './interfaces';
import {
  LIFECYCLE_ORPHAN_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_REGISTRY_TAG,
  LIFECYCLE_REGISTRY_WORKFLOW,
  lifecycleRegistryNamespace,
  lifecycleRegistryRunId,
  runCompletedEvent,
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
const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;
const owedOf = (run: WorkflowRun | null) =>
  (run?.tags ?? []).filter((t) => t.startsWith(LIFECYCLE_OWED_TAG_PREFIX)).sort();

const count = (runs: Record<string, number>, name: string) => {
  runs[name] = (runs[name] ?? 0) + 1;
};

/** A tenant engine of `namespace` with `subscriber` on `run.completed:ingest`, heartbeat written. */
async function tenantEngine(
  store: InMemoryStateStore,
  namespace: string,
  subscriber: string,
  runs: Record<string, number>,
): Promise<WorkflowEngine> {
  const engine = new WorkflowEngine({ store, namespace, instanceId: `engine-${namespace}` });
  engine.register(
    subscriber,
    '1',
    async () => {
      count(runs, subscriber);
    },
    {
      onEvent: [runCompletedEvent('ingest')],
    },
  );
  await engine.heartbeatLifecycleRegistry();
  return engine;
}

describe('lifecycle subscribers are scoped to the settled run namespace', () => {
  it('records in the registry run whether its engine has a namespace', async () => {
    const store = new InMemoryStateStore();
    const operator = new WorkflowEngine({ store, instanceId: 'op' });
    operator.register('x', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    const scoped = new WorkflowEngine({ store, instanceId: 'dflt', namespace: 'default' });
    scoped.register('y', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await operator.heartbeatLifecycleRegistry();
    await scoped.heartbeatLifecycleRegistry();

    expect((await store.getRun(lifecycleRegistryRunId('op')))?.input).toMatchObject({
      engineNamespace: null,
    });
    expect((await store.getRun(lifecycleRegistryRunId('dflt')))?.input).toMatchObject({
      engineNamespace: 'default',
    });
    expect((await store.getRun(lifecycleRegistryRunId('dflt')))?.namespace).toBe(
      (await store.getRun(lifecycleRegistryRunId('op')))?.namespace,
    );
  });

  it('a tenant run an engine without a namespace settles is owed to its tenant only', async () => {
    const store = new InMemoryStateStore();
    const runs: Record<string, number> = {};
    const acme = await tenantEngine(store, 'acme', 'acme-notify', runs);
    const beta = await tenantEngine(store, 'beta', 'beta-notify', runs);
    const dflt = await tenantEngine(store, 'default', 'default-notify', runs);
    const operator = new WorkflowEngine({ store, instanceId: 'op' });
    operator.register('ingest', '1', async () => 'ok');

    await operator.start('ingest', {}, 'i1', { namespace: 'acme' });
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    expect(owedOf(await store.getRun('i1'))).toEqual([owed('acme-notify')]);
    expect(await operator.lifecycleSubscribers('ingest', 'completed', 'acme')).toEqual([
      'acme-notify',
    ]);

    const later = Date.now() + 60_000;
    expect(await beta.sweepLifecycleEvents(later)).toBe(0);
    expect(await dflt.sweepLifecycleEvents(later)).toBe(0);
    expect(await acme.sweepLifecycleEvents(later)).toBe(1);
    await poll(
      async () => (await store.getRun('evt:i1:completed:acme-notify'))?.status === 'completed',
    );
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:acme-notify']);
    expect(runs).toEqual({ 'acme-notify': 1 });
  });

  it('a default run is owed to default subscribers, not to tenant ones', async () => {
    const store = new InMemoryStateStore();
    const runs: Record<string, number> = {};
    await tenantEngine(store, 'acme', 'acme-notify', runs);
    await tenantEngine(store, 'default', 'default-notify', runs);
    const operator = new WorkflowEngine({ store, instanceId: 'op' });
    operator.register('ingest', '1', async () => 'ok');

    await operator.start('ingest', {}, 'd1');
    await poll(async () => (await store.getRun('d1'))?.status === 'completed');
    await settle();
    expect(owedOf(await store.getRun('d1'))).toEqual([owed('default-notify')]);
  });

  it('an engine without a namespace starts its own subscribers for every namespace', async () => {
    const store = new InMemoryStateStore();
    const runs: Record<string, number> = {};
    await tenantEngine(store, 'beta', 'beta-notify', runs);
    const operator = new WorkflowEngine({ store, instanceId: 'op' });
    operator.register('ingest', '1', async () => 'ok');
    operator.register(
      'audit',
      '1',
      async () => {
        count(runs, 'audit');
      },
      {
        onEvent: [runCompletedEvent('ingest')],
      },
    );
    await operator.heartbeatLifecycleRegistry();

    await operator.start('ingest', {}, 't1', { namespace: 'acme' });
    await operator.start('ingest', {}, 'd1');
    await poll(async () => (await store.getRun('evt:t1:completed:audit'))?.status === 'completed');
    await poll(async () => (await store.getRun('evt:d1:completed:audit'))?.status === 'completed');
    await settle();
    expect((await store.getRun('t1'))?.tags).toEqual(['durable:triggered:audit']);
    expect((await store.getRun('d1'))?.tags).toEqual(['durable:triggered:audit']);
    expect(runs).toEqual({ audit: 2 });
  });

  it('a tenant engine owes its runs to the subscribers of an engine without a namespace', async () => {
    const store = new InMemoryStateStore();
    const runs: Record<string, number> = {};
    const operator = new WorkflowEngine({ store, instanceId: 'op' });
    operator.register(
      'audit',
      '1',
      async () => {
        count(runs, 'audit');
      },
      {
        onEvent: [runCompletedEvent('ingest')],
      },
    );
    await operator.heartbeatLifecycleRegistry();
    const dflt = await tenantEngine(store, 'default', 'default-notify', runs);
    const acme = new WorkflowEngine({ store, namespace: 'acme', instanceId: 'engine-acme' });
    acme.register('ingest', '1', async () => 'ok');
    void dflt;

    await acme.start('ingest', {}, 'a1');
    await poll(async () => (await store.getRun('a1'))?.status === 'completed');
    await settle();
    expect(owedOf(await store.getRun('a1'))).toEqual([owed('audit')]);

    expect(await operator.sweepLifecycleEvents(Date.now() + 60_000)).toBe(1);
    await poll(async () => (await store.getRun('evt:a1:completed:audit'))?.status === 'completed');
    expect(runs).toEqual({ audit: 1 });
  });

  it('drops an owed subscriber announced only in another namespace as an orphan', async () => {
    const store = new InMemoryStateStore();
    let now = LIFECYCLE_ORPHAN_MS * 2;
    const runs: Record<string, number> = {};
    const beta = new WorkflowEngine({
      store,
      namespace: 'beta',
      instanceId: 'engine-beta',
      clock: () => now,
    });
    beta.register(
      'beta-notify',
      '1',
      async () => {
        count(runs, 'beta');
      },
      {
        onEvent: [runCompletedEvent('ingest')],
      },
    );
    await beta.heartbeatLifecycleRegistry();
    const operator = new WorkflowEngine({ store, instanceId: 'op', clock: () => now });
    const events: EngineEvent[] = [];
    operator.subscribe((e) => events.push(e));
    await store.createRun({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      namespace: 'acme',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG, owed('beta-notify')],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    now += 1;
    await operator.sweepLifecycleEvents(now);
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:trigger_failed:beta-notify']);
    expect(events.filter((e) => e.type === 'run.trigger_failed')).toMatchObject([
      {
        runId: 'i1',
        name: 'beta-notify',
        error: { message: 'subscriber beta-notify is not registered on any live worker' },
      },
    ]);
    expect(runs).toEqual({});
  });

  it('reads a registry run written without engineNamespace by the namespace it is stored under', async () => {
    const store = new InMemoryStateStore();
    const now = Date.now();
    for (const [instanceId, namespace, workflow] of [
      ['older-default', undefined, 'anywhere'],
      ['older-acme', 'acme', 'acme-only'],
    ] as const) {
      await store.createRun({
        id: lifecycleRegistryRunId(instanceId),
        workflow: LIFECYCLE_REGISTRY_WORKFLOW,
        workflowVersion: '1',
        status: 'completed',
        input: {
          instanceId,
          runtime: 'node',
          subscriptions: [{ workflow, events: [runCompletedEvent('ingest')] }],
        },
        tags: [LIFECYCLE_REGISTRY_TAG],
        ...(namespace ? { namespace } : {}),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
    }
    const operator = new WorkflowEngine({ store });
    expect(await operator.lifecycleSubscribers('ingest', 'completed', 'acme')).toEqual([
      'acme-only',
      'anywhere',
    ]);
    expect(await operator.lifecycleSubscribers('ingest', 'completed', 'beta')).toEqual([
      'anywhere',
    ]);
    expect(await operator.lifecycleSubscribers('ingest', 'completed')).toEqual([
      'acme-only',
      'anywhere',
    ]);
    expect(lifecycleRegistryNamespace({ engineNamespace: '' }, 'acme')).toBe('default');
    expect(lifecycleRegistryNamespace({ engineNamespace: null }, 'default')).toBeNull();
  });
});
