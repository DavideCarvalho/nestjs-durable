import 'reflect-metadata';
import {
  FatalError,
  InMemoryStateStore,
  InMemoryTransport,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowLifecycleEvent,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  OnDurableEvent,
  OnWorkflowCompleted,
  OnWorkflowFailed,
  Workflow,
  type WorkflowMeta,
  eventBatchOf,
  getWorkflowMeta,
} from './decorators';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

interface IngestInput {
  table: string;
  fail?: boolean;
  park?: boolean;
}

const seen: Record<string, WorkflowLifecycleEvent[]> = { mvr: [], failed: [] };

@Workflow({ name: 'ingest', version: '1' })
class IngestWorkflow {
  async run(ctx: WorkflowCtx, input: IngestInput): Promise<{ rows: number }> {
    await ctx.upsertSearchAttributes({ table: input.table });
    if (input.fail) throw new FatalError('bad file', 'bad_file');
    if (input.park) await ctx.waitForSignal('never');
    return { rows: 2 };
  }
}

@Workflow({ name: 'mvr-summaries', version: '1' })
@OnWorkflowCompleted(IngestWorkflow, { where: (e) => e.input.table === 'mvr' })
class MvrSummariesWorkflow {
  async run(_ctx: WorkflowCtx, event: WorkflowLifecycleEvent<IngestInput, { rows: number }>) {
    seen.mvr?.push(event);
    return event.output?.rows;
  }
}

@Workflow({ name: 'ingest-alert', version: '1' })
@OnWorkflowFailed('ingest')
class IngestAlertWorkflow {
  async run(_ctx: WorkflowCtx, event: WorkflowLifecycleEvent) {
    seen.failed?.push(event);
  }
}

@Workflow({ name: 'mvr-refresh', version: '1' })
@OnWorkflowCompleted(IngestWorkflow, {
  where: (e) => e.input.table === 'mvr',
  input: (e) => ({ table: e.input.table, rows: e.output?.rows ?? 0 }),
})
class MvrRefreshWorkflow {
  async run(_ctx: WorkflowCtx, input: { table: string; rows: number }) {
    return input;
  }
}

@Workflow({ name: 'failure-pager', version: '1' })
@OnWorkflowFailed(IngestWorkflow, { statuses: ['failed', 'dead'] })
class FailurePagerWorkflow {
  async run(_ctx: WorkflowCtx, event: WorkflowLifecycleEvent<IngestInput>) {
    return event.status;
  }
}

@Workflow({ name: 'mixed', version: '1' })
@OnDurableEvent('plain.event', { event: 'filtered.event', where: (p) => (p as { ok: boolean }).ok })
class MixedWorkflow {
  async run(_ctx: WorkflowCtx, input: unknown) {
    return input;
  }
}

async function boot() {
  const store = new InMemoryStateStore();
  const mod = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 })],
    providers: [
      IngestWorkflow,
      MvrSummariesWorkflow,
      IngestAlertWorkflow,
      MixedWorkflow,
      MvrRefreshWorkflow,
      FailurePagerWorkflow,
    ],
  }).compile();
  await mod.init();
  return { store, svc: mod.get(WorkflowService), engine: mod.get(WorkflowEngine) };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('@OnWorkflowCompleted / @OnWorkflowFailed', () => {
  it('starts the subscriber on completion, filtered by where, with the settled run as input', async () => {
    const { store, svc } = await boot();

    await svc.start(IngestWorkflow, { table: 'mel' }, 'mel-1');
    await svc.start(IngestWorkflow, { table: 'mvr' }, 'mvr-1');
    await svc.waitForRun('mvr-1');
    await svc.waitForRun('evt:mvr-1:completed:mvr-summaries');
    await settle();

    expect((await store.getRun('evt:mvr-1:completed:mvr-summaries'))?.output).toBe(2);
    expect(await store.getRun('evt:mel-1:completed:mvr-summaries')).toBeNull();
    expect(seen.mvr?.[0]).toMatchObject({
      runId: 'mvr-1',
      input: { table: 'mvr' },
      searchAttributes: { table: 'mvr' },
    });
  });

  it('starts the failed-subscriber, by string name, when the run fails', async () => {
    const { svc } = await boot();

    await svc.start(IngestWorkflow, { table: 'mvr', fail: true }, 'bad-1');
    await svc.waitForRun('evt:bad-1:failed:ingest-alert');

    expect(seen.failed?.[0]).toMatchObject({ runId: 'bad-1', status: 'failed' });
  });

  it('lets @OnDurableEvent mix plain names with { event, where } subscriptions', async () => {
    const { store, svc } = await boot();

    expect(await svc.publishEvent('plain.event', { a: 1 }, { id: 'p1' })).toBe(1);
    expect(
      await svc.publishEvent('filtered.event', { ok: false }, { id: 'f0', buffer: false }),
    ).toBe(0);
    expect(await svc.publishEvent('filtered.event', { ok: true }, { id: 'f1' })).toBe(1);
    expect(await store.getRun('evt:f1:mixed')).not.toBeNull();
  });
});

describe('lifecycle decorator options', () => {
  it('starts the subscriber with what input builds from the event', async () => {
    const { store, svc } = await boot();

    await svc.start(IngestWorkflow, { table: 'mvr' }, 'mvr-2');
    await svc.waitForRun('evt:mvr-2:completed:mvr-refresh');

    expect((await store.getRun('evt:mvr-2:completed:mvr-refresh'))?.input).toEqual({
      table: 'mvr',
      rows: 2,
    });
  });

  it('starts a failed-subscriber only for the statuses it asked for', async () => {
    const { store, svc, engine } = await boot();

    await svc.start(IngestWorkflow, { table: 'mvr', fail: true }, 'bad-2');
    await svc.waitForRun('evt:bad-2:failed:failure-pager');
    expect((await store.getRun('evt:bad-2:failed:failure-pager'))?.output).toBe('failed');

    await svc.start(IngestWorkflow, { table: 'mvr', park: true }, 'cancel-me');
    await svc.waitForRun('cancel-me');
    await engine.cancel('cancel-me');
    await svc.waitForRun('evt:cancel-me:failed:ingest-alert');
    await settle();
    expect(await store.getRun('evt:cancel-me:failed:failure-pager')).toBeNull();
  });
});

describe('@OnWorkflowCompleted with an undecorated class', () => {
  it('fails at decoration with the workflow-name error', () => {
    class NotAWorkflow {
      async run() {}
    }
    expect(() => OnWorkflowCompleted(NotAWorkflow)).toThrow(/has no registered name/);
  });
});

const metaOf = (target: abstract new (...args: never[]) => unknown) =>
  getWorkflowMeta(target) as WorkflowMeta;

describe('lifecycle subscriptions with debounce / batch', () => {
  it('maps debounce and batch, with their key, onto the workflow coalescing', () => {
    const key = (input: { baseId: string }) => input.baseId;

    @Workflow({ name: 'debounced-sub', version: '1' })
    @OnWorkflowCompleted(IngestWorkflow, {
      input: (e) => ({ baseId: e.input.table }),
      debounce: { windowMs: '30s', key },
    })
    class DebouncedSub {
      async run(_ctx: WorkflowCtx, input: { baseId: string }) {
        return input;
      }
    }

    @Workflow({ name: 'batched-sub', version: '1' })
    @OnWorkflowFailed(IngestWorkflow, { batch: { maxSize: 5, windowMs: 1000 } })
    class BatchedSub {
      async run(_ctx: WorkflowCtx, input: { events: unknown[] }) {
        return input;
      }
    }

    expect(eventBatchOf(metaOf(DebouncedSub), DebouncedSub)).toEqual({
      mode: 'debounce',
      windowMs: 30_000,
      key,
    });
    expect(eventBatchOf(metaOf(BatchedSub), BatchedSub)).toEqual({
      mode: 'batch',
      maxSize: 5,
      windowMs: 1000,
    });
  });

  it('rejects debounce and batch on one subscription', () => {
    expect(() =>
      OnWorkflowCompleted('ingest', {
        debounce: { windowMs: 1000 },
        batch: { maxSize: 2, windowMs: 1000 },
      }),
    ).toThrow('run.completed:ingest: a subscription takes debounce or batch, not both');
  });

  it('throws when the workflow already declares a different coalescing', () => {
    @Workflow({ name: 'conflicting-sub', version: '1', debounce: '10s' })
    @OnWorkflowCompleted('ingest', { debounce: { windowMs: '30s' } })
    class ConflictingSub {
      async run(_ctx: WorkflowCtx, input: unknown) {
        return input;
      }
    }
    @Workflow({ name: 'agreeing-sub', version: '1', debounce: '30s' })
    @OnWorkflowCompleted('ingest', { debounce: { windowMs: 30_000 } })
    class AgreeingSub {
      async run(_ctx: WorkflowCtx, input: unknown) {
        return input;
      }
    }

    expect(() => eventBatchOf(metaOf(ConflictingSub), ConflictingSub)).toThrow(
      /workflow conflicting-sub: @Workflow declares debounce/,
    );
    expect(eventBatchOf(metaOf(AgreeingSub), AgreeingSub)).toEqual({
      mode: 'debounce',
      windowMs: 30_000,
    });
  });

  it('accepts the same key written separately on two decorators, and rejects a different one', () => {
    @Workflow({ name: 'twice-keyed-sub', version: '1' })
    @OnWorkflowCompleted(IngestWorkflow, {
      input: (e) => ({ table: e.input.table }),
      debounce: { windowMs: '30s', key: (input) => input.table },
    })
    @OnWorkflowFailed(IngestWorkflow, {
      input: (e) => ({ table: e.input.table }),
      debounce: { windowMs: '30s', key: (input) => input.table },
    })
    class TwiceKeyedSub {
      async run(_ctx: WorkflowCtx, input: { table: string }) {
        return input;
      }
    }
    expect(eventBatchOf(metaOf(TwiceKeyedSub), TwiceKeyedSub)).toMatchObject({
      mode: 'debounce',
      windowMs: 30_000,
    });

    expect(() => {
      @Workflow({ name: 'differently-keyed-sub', version: '1' })
      @OnWorkflowCompleted(IngestWorkflow, {
        input: (e) => ({ table: e.input.table }),
        debounce: { windowMs: '30s', key: (input) => input.table },
      })
      @OnWorkflowFailed(IngestWorkflow, {
        input: (e) => ({ table: e.input.table }),
        debounce: { windowMs: '30s', key: (input) => `${input.table}` },
      })
      class DifferentlyKeyedSub {
        async run(_ctx: WorkflowCtx, input: { table: string }) {
          return input;
        }
      }
      return DifferentlyKeyedSub;
    }).toThrow(/two lifecycle subscriptions declare different debounce\/batch settings/);
  });

  it('coalesces several settled runs with the same key into one subscriber run', async () => {
    const store = new InMemoryStateStore();
    const fired: unknown[] = [];

    @Workflow({ name: 'per-base', version: '1' })
    @OnWorkflowCompleted(IngestWorkflow, {
      input: (e) => ({ table: e.input.table }),
      debounce: { windowMs: 20, key: (input) => input.table },
    })
    class PerBaseWorkflow {
      async run(_ctx: WorkflowCtx, input: { table: string }) {
        fired.push(input);
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 }),
      ],
      providers: [IngestWorkflow, PerBaseWorkflow],
    }).compile();
    await mod.init();
    const svc = mod.get(WorkflowService);
    const engine = mod.get(WorkflowEngine);

    for (const [id, table] of [
      ['a1', 'mvr'],
      ['a2', 'mvr'],
      ['b1', 'mel'],
    ] as const) {
      await svc.start(IngestWorkflow, { table }, id);
      await svc.waitForRun(id);
    }
    expect(fired).toEqual([]);

    for (let i = 0; i < 50 && fired.length < 2; i += 1) {
      await settle();
      await engine.resumeDueTimers();
    }
    expect(fired).toHaveLength(2);
    expect(fired).toEqual(expect.arrayContaining([{ table: 'mvr' }, { table: 'mel' }]));
  });
});
