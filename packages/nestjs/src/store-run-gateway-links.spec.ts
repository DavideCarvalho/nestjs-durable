import {
  InMemoryStateStore,
  LIFECYCLE_ORPHAN_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_TRACE_TAG_PREFIX,
  type RunQuery,
  WorkflowEngine,
  type WorkflowRun,
  accumulatorRunId,
  lifecycleRunId,
  runCompletedEvent,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { StoreRunGateway } from './store-run-gateway';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

function settled(id: string, tags: string[], updatedAt = new Date()): WorkflowRun {
  return {
    id,
    workflow: 'ingest',
    workflowVersion: '1',
    status: 'completed',
    input: {},
    output: 'ok',
    tags,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('lifecycle deliveries on the run detail', () => {
  it('states each subscriber: started, owed, orphan, coalesced and not started', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    engine.register('digest', '1', async () => 'ok', {
      onEvent: [runCompletedEvent('ingest')],
      eventBatch: { mode: 'debounce', windowMs: 60_000 },
    });
    engine.register('waiting', '1', async () => 'ok', {
      onEvent: [runCompletedEvent('ingest')],
    });
    const settledAt = new Date('2026-11-01T00:00:00Z');
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    await store.createRun(
      settled(
        'i1',
        [
          LIFECYCLE_PENDING_TAG,
          `${LIFECYCLE_OWED_TAG_PREFIX}waiting`,
          `${LIFECYCLE_OWED_TAG_PREFIX}removed`,
          'durable:triggered:refresh',
        ],
        settledAt,
      ),
    );
    await store.createRun({ ...settled(started, []), workflow: 'refresh', status: 'running' });
    engine.register('late', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });

    const detail = await new StoreRunGateway(store, engine).getRunDetail('i1');
    expect(detail?.lifecycleDeliveries).toEqual([
      { subscriber: 'digest', state: 'coalesced', runId: accumulatorRunId('digest') },
      { subscriber: 'late', state: 'not-started' },
      {
        subscriber: 'refresh',
        state: 'started',
        runId: started,
        status: 'running',
        namespace: 'default',
      },
      {
        subscriber: 'removed',
        state: 'owed',
        owedSince: settledAt.getTime(),
        orphanAt: settledAt.getTime() + LIFECYCLE_ORPHAN_MS,
      },
      { subscriber: 'waiting', state: 'owed', owedSince: settledAt.getTime() },
    ]);
  });

  it('states a subscriber whose start failed as failed', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('strict', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await store.createRun(settled('i1', ['durable:trigger_failed:strict']));

    const detail = await new StoreRunGateway(store, engine).getRunDetail('i1');
    expect(detail?.lifecycleDeliveries).toEqual([{ subscriber: 'strict', state: 'failed' }]);
  });

  it('names the accumulator a keyed subscriber coalesced the event into', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('per-base', '1', async () => 'ok', {
      onEvent: [runCompletedEvent('ingest')],
      eventBatch: {
        mode: 'debounce',
        windowMs: 60_000,
        key: (event) => (event as { input: { base: string } }).input.base,
      },
    });
    engine.register('picky', '1', async () => 'ok', {
      onEvent: [{ event: runCompletedEvent('ingest'), where: () => false }],
      eventBatch: { mode: 'batch', maxSize: 10, windowMs: 60_000 },
    });
    await store.createRun({ ...settled('i1', []), input: { base: 'b1' } });

    const detail = await new StoreRunGateway(store, engine).getRunDetail('i1');
    expect(detail?.lifecycleDeliveries).toEqual([
      { subscriber: 'per-base', state: 'coalesced', runId: accumulatorRunId('per-base', 'b1') },
      { subscriber: 'picky', state: 'not-started' },
    ]);
  });

  it('changes the summarized detail ETag when a started subscriber run changes status', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    await store.createRun(settled('i1', ['durable:triggered:refresh']));
    await store.createRun({ ...settled(started, []), workflow: 'refresh', status: 'running' });
    const gateway = new StoreRunGateway(store, engine);

    const first = await gateway.getRunDetail('i1', { summarizeFansOver: 50 });
    const same = await gateway.getRunDetail('i1', {
      summarizeFansOver: 50,
      ifNoneMatch: first?.etag,
    });
    expect(same?.notModified).toBe(true);

    await store.updateRun(started, { status: 'completed' });
    const changed = await gateway.getRunDetail('i1', {
      summarizeFansOver: 50,
      ifNoneMatch: first?.etag,
    });
    expect(changed?.notModified).toBeUndefined();
    expect(changed?.lifecycleDeliveries?.[0]?.status).toBe('completed');
  });

  it('adds the source run status and its trace id to triggeredBy', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    await store.createRun(settled('i1', [`${LIFECYCLE_TRACE_TAG_PREFIX}${TRACEPARENT}`]));
    await store.createRun({ ...settled(started, []), workflow: 'refresh' });
    await store.createRun({ ...settled('i2', []), id: 'i2' });
    await store.createRun({
      ...settled(lifecycleRunId('i2', 'completed', 'refresh'), []),
      workflow: 'refresh',
    });
    const gateway = new StoreRunGateway(store, engine);

    expect((await gateway.getRunDetail(started))?.triggeredBy).toEqual({
      runId: 'i1',
      kind: 'completed',
      status: 'completed',
      namespace: 'default',
      traceId: TRACE_ID,
    });
    expect(
      (await gateway.getRunDetail(lifecycleRunId('i2', 'completed', 'refresh')))?.triggeredBy,
    ).toEqual({ runId: 'i2', kind: 'completed', status: 'completed', namespace: 'default' });
  });
});

describe('ctx.waitForRun links on the run detail', () => {
  it('links the waiting run to its target and back, and names the wait in the run list', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'ok';
    });
    engine.register('watcher', '1', async (ctx, input) => {
      await ctx.waitForRun((input as { target: string }).target);
      return 'seen';
    });
    await engine.start('ingest', {}, 'i1');
    await engine.start('watcher', { target: 'i1' }, 'w1');
    await poll(async () => (await store.getRun('w1'))?.status === 'suspended');
    const gateway = new StoreRunGateway(store, engine);

    const waiting = await gateway.getRunDetail('w1');
    expect(waiting?.waitsFor).toEqual([
      { runId: 'i1', seq: 0, status: 'suspended', namespace: 'default' },
    ]);
    expect(waiting?.awaitedBy).toBeUndefined();
    const target = await gateway.getRunDetail('i1', { summarizeFansOver: 50 });
    expect(target?.awaitedBy).toEqual([
      { runId: 'w1', seq: 0, status: 'suspended', namespace: 'default' },
    ]);
    expect(target?.waitsFor).toBeUndefined();
    const listed = await gateway.listRuns({ workflow: 'watcher' } as RunQuery);
    expect(listed[0]?.waiting).toEqual({ on: 'run', name: 'i1' });

    await engine.signal('go', undefined);
    await poll(async () => (await store.getRun('w1'))?.status === 'completed');
    expect((await gateway.getRunDetail('i1'))?.awaitedBy).toBeUndefined();
    expect((await gateway.getRunDetail('w1'))?.waitsFor).toBeUndefined();
  });
});
