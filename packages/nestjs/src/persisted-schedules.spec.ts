import {
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';

@Workflow({ name: 'tick-job', version: '1' })
class TickJob {
  async run(_ctx: unknown, input: { n: number }) {
    return input.n;
  }
}

async function boot(persistedSchedules: boolean) {
  const store = new InMemoryStateStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store,
        transport: new InMemoryTransport(),
        timerPollMs: 20,
        persistedSchedules,
      }),
    ],
    providers: [TickJob],
  }).compile();
  await moduleRef.init();
  return { store, moduleRef, engine: moduleRef.get(WorkflowEngine) };
}

describe('persistedSchedules', () => {
  it('the timer poller fires due persisted schedules', async () => {
    const { store, moduleRef, engine } = await boot(true);
    await engine.schedules.create({ id: 'fast', workflow: TickJob, input: { n: 7 }, every: 50 });

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (await store.listRuns({ tag: 'schedule:fast' })).length === 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const runs = await store.listRuns({ tag: 'schedule:fast' });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.workflow).toBe('tick-job');
    await moduleRef.close();
  });

  it('does not fire them when the option is off', async () => {
    const { store, moduleRef, engine } = await boot(false);
    await engine.schedules.create({ id: 'off', workflow: 'tick-job', every: 20 });
    await new Promise((r) => setTimeout(r, 200));
    expect(await store.listRuns({ tag: 'schedule:off' })).toEqual([]);
    await moduleRef.close();
  });
});
