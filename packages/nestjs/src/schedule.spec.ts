import { InMemoryStateStore, InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
// The facade: everything the scheduling docs use comes from the one NestJS package.
import { type ScheduledWorkflow, WorkflowEngine, runSchedules, scheduleRunIdAt } from './index';

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

  it("finds a window's run from the schedule itself, through the injected engine", async () => {
    const store = new InMemoryStateStore();
    const beat: ScheduledWorkflow = { key: 'beat', workflow: 'beat', everyMs: 60_000 };
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          transport: new InMemoryTransport(),
          timerPollMs: 0,
          schedules: [beat],
        }),
      ],
      providers: [BeatWorkflow],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine);
    const run = await engine.getRun(scheduleRunIdAt(beat, Date.now()));

    expect(run?.workflow).toBe('beat');
    expect(run?.output).toBe('tick');
    await moduleRef.close();
  });

  it('a producer-only app fires schedules with runSchedules; a driving instance runs them', async () => {
    const store = new InMemoryStateStore();
    const beat: ScheduledWorkflow = { key: 'beat', workflow: 'beat', everyMs: 60_000 };
    const producer = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          transport: new InMemoryTransport(),
          drive: false,
          consumers: false,
          timerPollMs: 0,
        }),
      ],
      providers: [BeatWorkflow],
    }).compile();
    await producer.init();

    const now = Date.now();
    const [runId] = await runSchedules(producer.get(WorkflowEngine), [beat], now);

    // Enqueued, not executed: a `drive: false` process never runs a body.
    expect(runId).toBe(scheduleRunIdAt(beat, now));
    expect((await store.getRun(runId ?? ''))?.status).toBe('pending');
    await producer.close();

    const worker = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 }),
      ],
      providers: [BeatWorkflow],
    }).compile();
    await worker.init();
    const engine = worker.get(WorkflowEngine);
    expect((await engine.waitForRun(runId ?? '', { timeoutMs: 5_000 })).status).toBe('completed');
    await worker.close();
  });
});
