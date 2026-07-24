import {
  type Heartbeat,
  InMemoryStateStore,
  type RemoteTask,
  type StepResult,
  type Transport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DurableModule } from './durable.module';

class Broker implements Transport {
  liveGroups: string[] = [];
  readonly stepGroups: string[] = [];
  async dispatch(task: RemoteTask): Promise<void> {
    this.stepGroups.push(task.group);
  }
  onResult(_h: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}
  async listWorkerGroups(): Promise<string[]> {
    return this.liveGroups;
  }
}

async function poll(fn: () => Promise<boolean>, ms = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

describe('DurableModule.forRoot({ blockOnAbsentWorker }) flows to the engine', () => {
  it('true → a step to an absent group parks the run blocked', async () => {
    const store = new InMemoryStateStore();
    const transport = new Broker();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store, transport, blockOnAbsentWorker: true, timerPollMs: 0 }),
      ],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine);
    engine.register('w', '1', async (ctx) => {
      await ctx.step('ingest', {});
      return 'ok';
    });

    await engine.start('w', {}, 'r1');
    await poll(async () => (await store.getRun('r1'))?.status === 'blocked');

    expect(transport.stepGroups).toEqual([]);
    expect((await store.getRun('r1'))?.error?.code).toBe('worker.absent');

    await moduleRef.close();
  });

  it('omitted (default) → the step is dispatched into the queue (unchanged)', async () => {
    const store = new InMemoryStateStore();
    const transport = new Broker();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport, timerPollMs: 0 })],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine);
    engine.register('w', '1', async (ctx) => {
      await ctx.step('ingest', {});
      return 'ok';
    });

    await engine.start('w', {}, 'r2');
    await poll(async () => (await store.getRun('r2'))?.status === 'suspended');

    expect(transport.stepGroups).toEqual(['ingest']);

    await moduleRef.close();
  });
});
