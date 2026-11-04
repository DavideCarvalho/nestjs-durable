import {
  InMemoryStateStore,
  type RunGateway,
  WorkflowEngine,
  lifecycleRunId,
  runCompletedEvent,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';

async function poll(fn: () => Promise<boolean> | boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

function engineWithSubscribers() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('ingest', '1', async () => 'ok');
  engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
  engine.register('picky', '1', async () => 'ok', {
    onEvent: [
      {
        event: runCompletedEvent('ingest'),
        where: () => {
          throw new Error('boom');
        },
      },
    ],
  });
  const gateway = {
    workflowLifecycle: (workflow: string) => engine.workflowLifecycle(workflow),
  } as unknown as RunGateway;
  return { store, engine, gateway };
}

describe("the workflow page's trigger counts", () => {
  it('counts each subscriber triggered and failed since the server started', async () => {
    const { store, engine, gateway } = engineWithSubscribers();
    const service = new DashboardService(gateway, store, engine);

    await engine.start('ingest', {}, 'i1');
    await engine.start('ingest', {}, 'i2');
    await poll(
      async () =>
        (await store.getRun(lifecycleRunId('i2', 'completed', 'refresh')))?.status === 'completed',
    );
    await poll(async () => {
      const view = await service.workflowLifecycle('ingest');
      return view?.triggerCounts?.picky?.failed === 2;
    });

    expect((await service.workflowLifecycle('ingest'))?.triggerCounts).toEqual({
      picky: { triggered: 0, failed: 2 },
      refresh: { triggered: 2, failed: 0 },
    });
  });

  it('answers the links alone off the control plane', async () => {
    const { gateway } = engineWithSubscribers();
    const view = await new DashboardService(gateway).workflowLifecycle('ingest');
    expect(view?.startsOnSettle.map((l) => l.workflow)).toEqual(['picky', 'refresh']);
    expect(view).not.toHaveProperty('triggerCounts');
  });
});
