import { InMemoryStateStore, InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';

@Workflow({ name: 'beat', version: '1' })
class BeatWorkflow {
  async run() {
    return 'tick';
  }
}

describe('scheduled workflows', () => {
  it('fires a configured schedule on bootstrap (driving operator)', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          transport: new InMemoryTransport(),
          timerPollMs: 0,
          schedules: [{ key: 'beat', workflow: 'beat', everyMs: 60_000 }],
        }),
      ],
      providers: [BeatWorkflow],
    }).compile();
    await moduleRef.init();

    const runs = await store.listRuns({ workflow: 'beat' });
    expect(runs.length).toBe(1);
    expect(runs[0]?.output).toBe('tick');
  });

  it('a dashboard-only instance (drive:false) does not fire schedules', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          transport: new InMemoryTransport(),
          drive: false,
          timerPollMs: 0,
          schedules: [{ key: 'beat', workflow: 'beat', everyMs: 60_000 }],
        }),
      ],
      providers: [BeatWorkflow],
    }).compile();
    await moduleRef.init();

    expect((await store.listRuns({ workflow: 'beat' })).length).toBe(0);
  });
});
