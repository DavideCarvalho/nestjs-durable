import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitter2 } from 'eventemitter2';
import { describe, expect, it } from 'vitest';
import { EventEmitterTransport } from './event-emitter-transport';

/**
 * The event-emitter transport lives in one process, so it carries no run queue: an engine on it
 * keeps executing runs in-process (bounded), and a wide fan still completes.
 */
describe('EventEmitterTransport and run dispatch', () => {
  it('carries no run queue, so runs stay in-process and a fan completes', async () => {
    const emitter = new EventEmitter2();
    const transport = new EventEmitterTransport(emitter);
    transport.handle('Lines.process', async (input: { i: number }) => input.i * 3);
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport,
      controlPlane: transport,
      reconcileMs: 0,
    });
    engine.register('child', '1', async (ctx, input) => ctx.step<number>('Lines.process', input));
    engine.register('parent', '1', async (ctx) =>
      ctx.all<number>(
        'child',
        Array.from({ length: 300 }, (_, i) => ({ i })),
      ),
    );
    expect('dispatchRuns' in transport).toBe(false);
    expect(engine.consumeRuns()).toBeUndefined();
    await engine.start('parent', {}, 'p');
    for (let i = 0; i < 2000; i += 1) {
      if ((await store.getRun('p'))?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await store.getRun('p'))?.output).toEqual(Array.from({ length: 300 }, (_, i) => i * 3));
  });
});
