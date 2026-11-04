import {
  InMemoryStateStore,
  LIFECYCLE_REGISTRY_TAG,
  LIFECYCLE_REGISTRY_WORKFLOW,
  WorkflowEngine,
  lifecycleRunId,
  runCompletedEvent,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { StoreRunGateway } from './store-run-gateway';
import { WorkflowService } from './workflow.service';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

async function settledPair() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('ingest', '1', async () => 'ok');
  engine.register('refresh', '1', async () => 'refreshed', {
    onEvent: [runCompletedEvent('ingest')],
  });
  await engine.start('ingest', {}, 'i1');
  const started = lifecycleRunId('i1', 'completed', 'refresh');
  await poll(async () => (await store.getRun(started))?.status === 'completed');
  return { store, engine, started, gateway: new StoreRunGateway(store, engine) };
}

describe('lifecycle links in the run detail', () => {
  it.each([
    ['full', undefined],
    ['summarized', { summarizeFansOver: 50 }],
  ])('lists both ends of the link (%s detail)', async (_shape, options) => {
    const { gateway, started } = await settledPair();

    const source = await gateway.getRunDetail('i1', options);
    expect(source?.triggered).toEqual([started]);
    expect(source?.triggeredBy).toBeUndefined();
    expect(source?.children).toEqual([]);

    const target = await gateway.getRunDetail(started, options);
    expect(target?.triggeredBy).toEqual({
      runId: 'i1',
      kind: 'completed',
      status: 'completed',
      namespace: 'default',
    });
    expect(target?.triggered).toBeUndefined();
  });

  it('answers through WorkflowService too', async () => {
    const { engine, started } = await settledPair();
    expect(await new WorkflowService(engine).triggeredRuns('i1')).toEqual([started]);
  });
});

describe("a workflow's lifecycle links through the gateway", () => {
  it('lists who starts whom on the run detail of either end, and by workflow name', async () => {
    const { gateway, started } = await settledPair();
    const refresh = {
      workflow: 'refresh',
      kind: 'completed',
      local: true,
      announced: false,
      where: false,
      input: false,
    };
    const ingest = { ...refresh, workflow: 'ingest' };

    expect((await gateway.getRunDetail('i1'))?.workflowLifecycle).toEqual({
      workflow: 'ingest',
      startsOnSettle: [refresh],
      startedBy: [],
    });
    expect(
      (await gateway.getRunDetail(started, { summarizeFansOver: 50 }))?.workflowLifecycle,
    ).toEqual({ workflow: 'refresh', startsOnSettle: [], startedBy: [ingest] });
    expect(await gateway.workflowLifecycle('refresh')).toEqual({
      workflow: 'refresh',
      startsOnSettle: [],
      startedBy: [ingest],
    });
  });

  it('leaves workflowLifecycle off the detail of a workflow nobody links to', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('alone', '1', async () => 'ok');
    await engine.start('alone', {}, 'a1');
    await poll(async () => (await store.getRun('a1'))?.status === 'completed');
    const detail = await new StoreRunGateway(store, engine).getRunDetail('a1');
    expect(detail).not.toHaveProperty('workflowLifecycle');
  });
});

describe('republishing lifecycle events through the gateway', () => {
  it('lists the subscribers of a settled run, and none for a run nobody subscribes to', async () => {
    const { gateway, started } = await settledPair();

    expect((await gateway.getRunDetail('i1'))?.lifecycleSubscribers).toEqual(['refresh']);
    expect(
      (await gateway.getRunDetail('i1', { summarizeFansOver: 50 }))?.lifecycleSubscribers,
    ).toEqual(['refresh']);
    expect((await gateway.getRunDetail(started))?.lifecycleSubscribers).toBeUndefined();
  });

  it('republishes a run, starting only what is missing', async () => {
    const { store, engine, gateway } = await settledPair();
    engine.register('late', '1', async () => 'late', { onEvent: [runCompletedEvent('ingest')] });

    expect(await gateway.republishLifecycle({ runId: 'i1' })).toEqual({
      runs: 1,
      started: 1,
      failed: [],
    });
    await poll(async () => (await store.getRun('evt:i1:completed:late'))?.status === 'completed');
    expect(await gateway.republishLifecycle({ runId: 'i1' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
    expect(await new WorkflowService(engine).republishLifecycle({ runId: 'i1' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
  });
});

describe('the lifecycle registry through the gateway', () => {
  it('keeps registry runs out of run lists, counts and pickers unless asked for by name', async () => {
    const { store, engine, gateway } = await settledPair();
    await engine.heartbeatLifecycleRegistry();
    expect(await store.listRuns({ workflow: LIFECYCLE_REGISTRY_WORKFLOW })).toHaveLength(1);

    const listed = await gateway.listRuns({});
    expect(listed.map((r) => r.workflow).sort()).toEqual(['ingest', 'refresh']);
    const facets = await gateway.runFacets({});
    expect(facets.reduce((sum, row) => sum + row.count, 0)).toBe(2);
    const workflows = await gateway.runValueFacets({ field: 'workflow' }, {});
    expect(workflows.map((row) => row.value).sort()).toEqual(['ingest', 'refresh']);
    expect(
      await gateway.listRuns({ statuses: ['completed'], tag: LIFECYCLE_REGISTRY_TAG }),
    ).toEqual([]);

    const named = await gateway.listRuns({ workflow: LIFECYCLE_REGISTRY_WORKFLOW });
    expect(named.map((r) => r.id)).toEqual([expect.stringMatching(/^__lifecycle_registry:/)]);
  });
});
