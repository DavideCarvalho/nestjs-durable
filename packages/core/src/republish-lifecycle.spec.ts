import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkerDescriptor } from './handshake/index';
import type { Transport, WorkflowRun } from './interfaces';
import {
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  runCompletedEvent,
  runFailedEvent,
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

function settled(id: string, over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflow: 'ingest',
    workflowVersion: '1',
    status: 'completed',
    input: { id },
    output: 'ok',
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
    ...over,
  };
}

describe('engine.republishLifecycle', () => {
  it('sends a debounced subscriber the event only while the run still owes it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('coalesce', '1', async () => 'ok', {
      onEvent: [runCompletedEvent('ingest')],
      eventBatch: { mode: 'debounce', windowMs: 60_000 },
    });
    await store.createRun(
      settled('owed', { tags: [LIFECYCLE_PENDING_TAG, `${LIFECYCLE_OWED_TAG_PREFIX}coalesce`] }),
    );
    await store.createRun(settled('done'));

    expect(await engine.republishLifecycle({ runId: 'owed' })).toEqual({
      runs: 1,
      started: 1,
      failed: [],
    });
    expect(await engine.republishLifecycle({ runId: 'done' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
  });

  it('backfills a subscriber registered after the runs settled, and starts nothing the second time', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async () => 'ok');
    await engine.start('ingest', {}, 'i1');
    await engine.start('ingest', {}, 'i2');
    await poll(async () => (await store.getRun('i2'))?.status === 'completed');

    const runs: unknown[] = [];
    engine.register('refresh', '1', async (_ctx, e) => void runs.push(e), {
      onEvent: [runCompletedEvent('ingest')],
    });

    expect(await engine.republishLifecycle({ workflow: 'ingest' })).toEqual({
      runs: 2,
      started: 2,
      failed: [],
    });
    await poll(async () => runs.length === 2);
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:refresh']);

    expect(await engine.republishLifecycle({ workflow: 'ingest' })).toEqual({
      runs: 2,
      started: 0,
      failed: [],
    });
    expect(await engine.republishLifecycle({ runId: 'i1' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
  });

  it('restricts to one subscriber, one kind and a settle window', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('a', '1', async () => 'a', { onEvent: [runCompletedEvent('ingest')] });
    engine.register('b', '1', async () => 'b', { onEvent: [runCompletedEvent('ingest')] });
    engine.register('alert', '1', async () => 'alert', { onEvent: [runFailedEvent('ingest')] });
    await store.createRun(settled('old', { updatedAt: new Date(1_000) }));
    await store.createRun(settled('new', { updatedAt: new Date(5_000) }));
    await store.createRun(settled('broke', { status: 'failed', updatedAt: new Date(5_000) }));

    expect(
      await engine.republishLifecycle({
        workflow: 'ingest',
        kind: 'completed',
        since: new Date(2_000),
        subscriber: 'b',
      }),
    ).toEqual({ runs: 1, started: 1, failed: [] });
    expect(await store.getRun('evt:new:completed:b')).not.toBeNull();
    expect(await store.getRun('evt:new:completed:a')).toBeNull();
    expect(await store.getRun('evt:old:completed:b')).toBeNull();
    expect(await store.getRun('evt:broke:failed:alert')).toBeNull();

    expect(
      await engine.republishLifecycle({
        workflow: 'ingest',
        kind: 'failed',
        until: new Date(9_000),
      }),
    ).toEqual({ runs: 1, started: 1, failed: [] });
    expect(await store.getRun('evt:broke:failed:alert')).not.toBeNull();
  });

  it('reports a subscriber that cannot start, and a subscriber that does not subscribe', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('strict', '1', async () => 'ran', {
      onEvent: [runCompletedEvent('ingest')],
      validateInput: () => {
        throw new Error('bad input');
      },
    });
    await store.createRun(settled('i1'));

    expect(await engine.republishLifecycle({ runId: 'i1' })).toEqual({
      runs: 1,
      started: 0,
      failed: [{ runId: 'i1', subscriber: 'strict', error: 'bad input' }],
    });
    expect(await engine.republishLifecycle({ runId: 'i1', subscriber: 'nobody' })).toEqual({
      runs: 1,
      started: 0,
      failed: [
        {
          runId: 'i1',
          subscriber: 'nobody',
          error: 'subscriber nobody does not subscribe to run.completed:ingest',
        },
      ],
    });
  });

  it('rejects a run that does not exist or has not settled', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    await store.createRun(settled('live', { status: 'running' }));

    await expect(engine.republishLifecycle({ runId: 'missing' })).rejects.toThrow(
      'run missing not found',
    );
    await expect(engine.republishLifecycle({ runId: 'live' })).rejects.toThrow(
      'run live has not settled (running)',
    );
  });

  it('pages through more runs than one page, up to the limit', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    for (let i = 0; i < 250; i += 1) await store.createRun(settled(`r${i}`));

    expect((await engine.republishLifecycle({ workflow: 'ingest', limit: 210 })).runs).toBe(210);
    expect((await engine.republishLifecycle({ workflow: 'ingest' })).started).toBe(40);
  });

  it('owes the event again to a subscriber only the fleet announces', async () => {
    const store = new InMemoryStateStore();
    const descriptor: WorkerDescriptor = {
      instanceId: 'w1',
      runtime: 'node',
      sdk: { name: 'sdk', version: '1' },
      protocol: { version: 1, range: [1, 1] },
      capabilities: [],
      workflows: ['remote'],
      steps: [],
      registrations: [{ name: 'remote', subscribes: [runCompletedEvent('ingest')] }],
      startedAt: 0,
    };
    const transport: Transport = {
      async dispatch(): Promise<void> {},
      onResult(): void {},
      onHeartbeat(): void {},
      async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
        return [descriptor];
      },
    };
    const dashboard = new WorkflowEngine({ store, transport });
    await store.createRun(settled('i1', { tags: ['etl'] }));

    expect(await dashboard.republishLifecycle({ runId: 'i1' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
    expect((await store.getRun('i1'))?.tags).toEqual([
      'etl',
      LIFECYCLE_PENDING_TAG,
      `${LIFECYCLE_OWED_TAG_PREFIX}remote`,
    ]);

    const worker = new WorkflowEngine({ store });
    worker.register('remote', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    expect(await worker.sweepLifecycleEvents(60_000)).toBe(1);
    expect((await store.getRun('i1'))?.tags).toEqual(['etl', 'durable:triggered:remote']);
  });
});
