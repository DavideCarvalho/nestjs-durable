import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DurableControlPlaneModule } from './durable.module';

describe('DurableControlPlaneModule', () => {
  it('wires an engine with the no-op run dispatcher (worker:false) — a started run stays pending', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableControlPlaneModule.forRoot({ store })],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    // A registered body would run inline on a worker; the control plane must NOT execute it.
    engine.register('processing', '1', async (_ctx, input) => input);

    await engine.start('processing', { hello: 'world' }, 'cp-1');
    // Give any (wrongly-wired) in-process dispatcher a chance to run — it must not.
    await new Promise((r) => setImmediate(r));

    const run = await store.getRun('cp-1');
    expect(run?.status).toBe('pending');

    await moduleRef.close();
  });

  it('forces worker:false even when the caller passes worker:true', async () => {
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
    expect(run?.status).toBe('pending');

    await moduleRef.close();
  });

  it('forRootAsync also forces worker:false', async () => {
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
    expect(run?.status).toBe('pending');

    await moduleRef.close();
  });
});
