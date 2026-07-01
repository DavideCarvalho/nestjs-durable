import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DurableControlPlaneModule } from './durable.module';

describe('DurableControlPlaneModule', () => {
  it('wires the engine default run dispatcher (drive:true) — a started run is driven, not orphaned pending', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableControlPlaneModule.forRoot({ store })],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    engine.register('processing', '1', async (_ctx, input) => input);

    await engine.start('processing', { hello: 'world' }, 'cp-1');
    // Give the (now real, non-no-op) in-process dispatcher a chance to run.
    await new Promise((r) => setImmediate(r));

    const run = await store.getRun('cp-1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ hello: 'world' });

    await moduleRef.close();
  });

  it('forces worker:false + drive:true even when the caller passes worker:true', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableControlPlaneModule.forRoot({ store, worker: true })],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    engine.register('processing', '1', async (_ctx, input) => input);

    await engine.start('processing', {}, 'cp-2');
    await new Promise((r) => setImmediate(r));

    const run = await store.getRun('cp-2');
    expect(run?.status).toBe('completed');

    await moduleRef.close();
  });

  it('forRootAsync also forces worker:false + drive:true', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableControlPlaneModule.forRootAsync({ useFactory: () => ({ store, worker: true }) }),
      ],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    engine.register('processing', '1', async (_ctx, input) => input);

    await engine.start('processing', {}, 'cp-3');
    await new Promise((r) => setImmediate(r));

    const run = await store.getRun('cp-3');
    expect(run?.status).toBe('completed');

    await moduleRef.close();
  });
});
