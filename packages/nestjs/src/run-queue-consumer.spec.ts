import {
  InMemoryRunQueue,
  InMemoryStateStore,
  type RunConsumerOptions,
  type ScheduledWorkflow,
  type Transport,
  WorkflowEngine,
  scheduleRunIdAt,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';

/**
 * A driving operator consumes the transport's run queue, so the runs it starts spread over every
 * driving instance; a dashboard-only operator (`drive: false`) and a thin worker never do. Shutdown
 * stops the consumer and waits for the runs it holds, within `shutdownTimeoutMs`.
 */

@Workflow({ name: 'queued-report' })
class QueuedReport {
  async run(_ctx: unknown, input: { region: string }) {
    return `report for ${input.region}`;
  }
}

function queueTransport() {
  const consumers: RunConsumerOptions[] = [];
  const stopped: number[] = [];
  const queued: string[] = [];
  const inner = new InMemoryRunQueue().transport();
  const transport: Transport = {
    ...inner,
    dispatchRuns: async (runs, opts) => {
      queued.push(...runs.map((r) => r.runId));
      await inner.dispatchRuns?.(runs, opts);
    },
    onDispatchedRun: (handler, opts) => {
      consumers.push(opts);
      const stop = (inner.onDispatchedRun as NonNullable<Transport['onDispatchedRun']>)(
        handler,
        opts,
      );
      return async () => {
        stopped.push(Date.now());
        await stop();
      };
    },
  };
  return { transport, consumers, stopped, queued };
}

async function until(check: () => boolean | Promise<boolean>, max = 2000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

describe('DurableModule run-queue consumer', () => {
  it('a driving operator consumes the run queue, and the runs it starts go through it', async () => {
    const q = queueTransport();
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport: q.transport, timerPollMs: 0 })],
    }).compile();
    await moduleRef.init();
    expect(q.consumers).toEqual([{ concurrency: 256 }]);
    const engine = moduleRef.get(WorkflowEngine);
    engine.register('wf', '1', async () => 'ok');
    await engine.start('wf', {}, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'completed');
    expect(q.queued).toEqual(['r']);
    await moduleRef.close();
    expect(q.stopped).toHaveLength(1);
  });

  it('a schedule given as a workflow class fires through the run queue', async () => {
    const q = queueTransport();
    const store = new InMemoryStateStore();
    const report: ScheduledWorkflow<typeof QueuedReport> = {
      key: 'queued-report',
      workflow: QueuedReport,
      input: { region: 'eu' },
      everyMs: 60_000,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          transport: q.transport,
          timerPollMs: 0,
          schedules: [report],
        }),
      ],
      providers: [QueuedReport],
    }).compile();
    await moduleRef.init();
    const runId = scheduleRunIdAt(report, Date.now());
    await until(async () => (await store.getRun(runId))?.status === 'completed');
    expect((await store.getRun(runId))?.output).toBe('report for eu');
    expect(q.queued).toContain(runId);
    await moduleRef.close();
  });

  it('a non-driving operator (drive: false) does not consume it', async () => {
    const q = queueTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: q.transport,
          drive: false,
          timerPollMs: 0,
        }),
      ],
    }).compile();
    await moduleRef.init();
    expect(q.consumers).toEqual([]);
    await moduleRef.close();
  });

  it('a thin worker does not consume it', async () => {
    const q = queueTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ connection: 'redis://x', transport: q.transport })],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(async () => ({ close: async () => undefined }))
      .compile();
    await moduleRef.init();
    expect(q.consumers).toEqual([]);
    await moduleRef.close();
  });

  it('shutdown stops taking runs and waits for the one in flight', async () => {
    const q = queueTransport();
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          transport: q.transport,
          timerPollMs: 0,
          shutdownTimeoutMs: 5_000,
        }),
      ],
    }).compile();
    await moduleRef.init();
    const engine = moduleRef.get(WorkflowEngine);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    engine.register('slow', '1', async (ctx) =>
      ctx.localStep('work', async () => {
        started += 1;
        await gate;
        return 1;
      }),
    );
    await engine.start('slow', {}, 'held');
    await until(() => started === 1);
    let closed = false;
    const closing = moduleRef.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    expect(q.stopped).toHaveLength(1);
    release();
    await closing;
    expect((await store.getRun('held'))?.status).toBe('completed');
  });

  it('shutdown gives up on a run in flight after shutdownTimeoutMs', async () => {
    const q = queueTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: q.transport,
          timerPollMs: 0,
          shutdownTimeoutMs: 300,
        }),
      ],
    }).compile();
    await moduleRef.init();
    const engine = moduleRef.get(WorkflowEngine);
    let started = 0;
    engine.register('stuck', '1', async (ctx) =>
      ctx.localStep('work', async () => {
        started += 1;
        await new Promise(() => undefined);
      }),
    );
    await engine.start('stuck', {}, 'stuck');
    await until(() => started === 1);
    const t0 = Date.now();
    await moduleRef.close();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(2_000);
  });
});
