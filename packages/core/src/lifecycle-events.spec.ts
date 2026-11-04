import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { FatalError } from './errors';
import type { EngineEvent, WorkflowRun } from './interfaces';
import {
  LIFECYCLE_COALESCED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX,
  type WorkflowLifecycleEvent,
  coalescedSubscribersOf,
  isLifecycleTag,
  lifecycleEventOf,
  lifecycleRunId,
  lifecycleSourceOf,
  runCompletedEvent,
  runFailedEvent,
  triggeredRunsOf,
} from './lifecycle-events';
import { runDetailEtag } from './run-detail-store';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const settle = () => new Promise((r) => setTimeout(r, 30));

function setup() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  const seen: WorkflowLifecycleEvent[] = [];
  return { store, engine, seen };
}

describe('lifecycle events (run.completed:<workflow> / run.failed:<workflow>)', () => {
  it('starts a completed-subscriber with the settled run, without the source knowing', async () => {
    const { store, engine, seen } = setup();
    engine.register('ingest', '1', async (ctx, input) => {
      await ctx.upsertSearchAttributes({ table: 'mvr' });
      return { rows: (input as { rows: number }).rows };
    });
    engine.register('refresh', '1', async (_ctx, event) => void seen.push(event as never), {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.start('ingest', { rows: 3 }, 'i1');
    await poll(
      async () => (await store.getRun('evt:i1:completed:refresh'))?.status === 'completed',
    );

    expect(seen).toEqual([
      expect.objectContaining({
        runId: 'i1',
        workflow: 'ingest',
        workflowVersion: '1',
        status: 'completed',
        input: { rows: 3 },
        output: { rows: 3 },
        searchAttributes: { table: 'mvr' },
      }),
    ]);
  });

  it('publishes a failed run only to failed-subscribers, with its error', async () => {
    const { store, engine, seen } = setup();
    const completed: unknown[] = [];
    engine.register('ingest', '1', async () => {
      throw new FatalError('bad file', 'bad_file');
    });
    engine.register('alert', '1', async (_ctx, event) => void seen.push(event as never), {
      onEvent: [runFailedEvent('ingest')],
    });
    engine.register('refresh', '1', async (_ctx, event) => void completed.push(event), {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('evt:i1:failed:alert'))?.status === 'completed');
    await settle();

    expect(seen[0]).toMatchObject({
      runId: 'i1',
      status: 'failed',
      error: { message: 'bad file', code: 'bad_file' },
    });
    expect(seen[0]).not.toHaveProperty('output');
    expect(completed).toEqual([]);
  });

  it('skips a subscriber whose where rejects the settled run', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async (_ctx, input) => input);
    engine.register('mvr-only', '1', async () => 'ran', {
      onEvent: [
        {
          event: runCompletedEvent('ingest'),
          where: (e) => (e as WorkflowLifecycleEvent<{ table: string }>).input.table === 'mvr',
        },
      ],
    });

    await engine.start('ingest', { table: 'mel' }, 'mel-run');
    await engine.start('ingest', { table: 'mvr' }, 'mvr-run');
    await poll(async () => (await store.getRun('evt:mvr-run:completed:mvr-only')) !== null);
    await settle();

    expect(await store.getRun('evt:mel-run:completed:mvr-only')).toBeNull();
  });

  it('publishes nothing, and buffers nothing, when no workflow subscribes', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => 'ok');

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();

    expect(await store.listBufferedEvents(runCompletedEvent('ingest'), 10)).toEqual([]);
  });

  it('does not buffer a lifecycle event that every subscriber filtered out', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => 'ok');
    engine.register('never', '1', async () => 'ran', {
      onEvent: [{ event: runCompletedEvent('ingest'), where: () => false }],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();

    expect(await store.listBufferedEvents(runCompletedEvent('ingest'), 10)).toEqual([]);
  });

  it('treats a continue-as-new handoff as not completed: only the last run of the chain fires', async () => {
    const { store, engine } = setup();
    engine.register('counter', '1', async (ctx, input) => {
      const n = (input as { n: number }).n;
      if (n < 3) await ctx.continueAsNew({ n: n + 1 });
      return n;
    });
    engine.register('after', '1', async (_ctx, event) => event, {
      onEvent: [runCompletedEvent('counter')],
    });

    await engine.start('counter', { n: 1 }, 'c1');
    await poll(
      async () => (await store.getRun('evt:c1~2:completed:after'))?.status === 'completed',
    );
    await settle();

    expect(await store.getRun('evt:c1:completed:after')).toBeNull();
    expect(await store.getRun('evt:c1~1:completed:after')).toBeNull();
    expect((await store.getRun('evt:c1~2:completed:after'))?.input).toMatchObject({ output: 3 });
  });
});

describe('onEvent where filters on published events', () => {
  it('starts only the subscribers whose where accepts the payload; a throwing where rejects', async () => {
    const { store, engine } = setup();
    engine.register('big', '1', async () => 'big', {
      onEvent: [{ event: 'order.placed', where: (p) => (p as { total: number }).total > 100 }],
    });
    engine.register('any', '1', async () => 'any', { onEvent: ['order.placed'] });
    engine.register('broken', '1', async () => 'broken', {
      onEvent: [
        {
          event: 'order.placed',
          where: () => {
            throw new Error('boom');
          },
        },
      ],
    });

    expect(await engine.publishEvent('order.placed', { total: 50 }, { id: 'small' })).toBe(1);
    expect(await engine.publishEvent('order.placed', { total: 500 }, { id: 'large' })).toBe(2);

    expect(await store.getRun('evt:small:big')).toBeNull();
    expect(await store.getRun('evt:large:big')).not.toBeNull();
    expect(await store.getRun('evt:small:broken')).toBeNull();
    expect(await store.getRun('evt:large:broken')).toBeNull();
  });

  it('starts a workflow subscribed twice to one event once, if any of its filters accepts', async () => {
    const { store, engine } = setup();
    engine.register('either', '1', async () => 'ran', {
      onEvent: [
        { event: 'x', where: (p) => (p as { a?: number }).a === 1 },
        { event: 'x', where: (p) => (p as { b?: number }).b === 1 },
      ],
    });

    expect(await engine.publishEvent('x', { b: 1 }, { id: 'e1' })).toBe(1);
    expect(await engine.publishEvent('x', { c: 1 }, { id: 'e2', buffer: false })).toBe(0);
    expect(await store.getRun('evt:e1:either')).not.toBeNull();
  });
});

describe('lifecycle links between runs', () => {
  it('names the started run deterministically and links both ends', async () => {
    const { store, engine } = setup();
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    engine.register('alert', '1', async () => 'alerted', {
      onEvent: [runFailedEvent('ingest')],
    });

    await engine.start('ingest', {}, 'i1');
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    expect(started).toBe('evt:i1:completed:refresh');
    await poll(async () => (await store.getRun(started))?.status === 'completed');

    expect(await engine.triggeredRuns('i1')).toEqual([started]);
    expect(lifecycleSourceOf((await store.getRun(started)) as WorkflowRun)).toEqual({
      runId: 'i1',
      kind: 'completed',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run.triggered',
        runId: 'i1',
        workflow: 'ingest',
        name: 'refresh',
        triggeredRunId: started,
      }),
    );
  });

  it('lists nothing for a run that has not settled or started nobody', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'ok';
    });
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [{ event: runCompletedEvent('ingest'), where: () => false }],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'suspended');
    expect(await engine.triggeredRuns('i1')).toEqual([]);

    await engine.signal('go', null);
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    expect(await engine.triggeredRuns('i1')).toEqual([]);
    expect(await engine.triggeredRuns('missing')).toEqual([]);
  });

  it('reads the source run from the id alone, even when it contains colons', () => {
    expect(lifecycleSourceOf({ id: 'manual-1', workflow: 'refresh' })).toBeUndefined();
    expect(
      lifecycleSourceOf({ id: 'evt:i1:completed:other', workflow: 'refresh' }),
    ).toBeUndefined();
    expect(lifecycleSourceOf({ id: 'evt:i1:failed:refresh', workflow: 'refresh' })).toEqual({
      runId: 'i1',
      kind: 'failed',
    });
    expect(
      lifecycleSourceOf({ id: 'evt:etl:b1:mvr:completed:refresh', workflow: 'refresh' }),
    ).toEqual({
      runId: 'etl:b1:mvr',
      kind: 'completed',
    });
  });
});

describe('lifecycle delivery guarantees', () => {
  const source = (over: Partial<WorkflowRun> = {}): WorkflowRun =>
    ({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: { baseId: 'b1' },
      output: { rows: 2 },
      tags: [LIFECYCLE_PENDING_TAG],
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...over,
    }) as WorkflowRun;

  it('writes the pending marker with the terminal status, then swaps it for the triggered tag', async () => {
    const { store, engine } = setup();
    const patches: Partial<WorkflowRun>[] = [];
    const updateRunIf = store.updateRunIf.bind(store);
    store.updateRunIf = async (id, expected, patch) => {
      if (id === 'i1') patches.push(patch);
      return updateRunIf(id, expected, patch);
    };
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(
      async () => (await store.getRun('i1'))?.tags?.includes('durable:triggered:refresh') ?? false,
    );

    expect(patches.find((p) => p.status === 'completed')?.tags).toEqual([
      LIFECYCLE_PENDING_TAG,
      'durable:lifecycle:owed:refresh',
    ]);
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:refresh']);
  });

  it('marks nothing when no workflow subscribes to that ending', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => 'ok');
    engine.register('alert', '1', async () => 'alerted', { onEvent: [runFailedEvent('ingest')] });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();

    expect((await store.getRun('i1'))?.tags ?? []).toEqual([]);
  });

  it('publishes, from the sweep, a run whose process died between settling and publishing', async () => {
    const { store, engine } = setup();
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await store.createRun(source());

    expect(await engine.sweepLifecycleEvents(60_000)).toBe(1);
    await poll(
      async () => (await store.getRun('evt:i1:completed:refresh'))?.status === 'completed',
    );

    expect((await store.getRun('evt:i1:completed:refresh'))?.input).toMatchObject({
      runId: 'i1',
      input: { baseId: 'b1' },
      tags: [],
    });
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:refresh']);
    expect(await engine.sweepLifecycleEvents(60_000)).toBe(0);
  });

  it('leaves a just-settled run to the live publish', async () => {
    const { store, engine } = setup();
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await store.createRun(source({ updatedAt: new Date(50_000) }));

    expect(await engine.sweepLifecycleEvents(60_000)).toBe(0);
    expect(await engine.sweepLifecycleEvents(90_000)).toBe(1);
  });

  it('keeps the marker when writing it back fails, and the sweep starts the subscriber once', async () => {
    const { store, engine } = setup();
    let failTagWrites = 1;
    const updateRun = store.updateRun.bind(store);
    store.updateRun = async (id, patch) => {
      if (id === 'i1' && !patch.status && failTagWrites-- > 0) throw new Error('store down');
      return updateRun(id, patch);
    };
    let runs = 0;
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => void runs++, {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(
      async () => (await store.getRun('evt:i1:completed:refresh'))?.status === 'completed',
    );
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual([
      LIFECYCLE_PENDING_TAG,
      'durable:lifecycle:owed:refresh',
    ]);

    expect(await engine.sweepLifecycleEvents(Date.now() + 60_000)).toBe(1);
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:refresh']);
    expect(runs).toBe(1);
  });

  it('reports a subscriber that cannot start, or whose where throws, without retrying it', async () => {
    const { store, engine } = setup();
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.register('ingest', '1', async () => 'ok');
    engine.register('strict', '1', async () => 'ran', {
      onEvent: [runCompletedEvent('ingest')],
      validateInput: () => {
        throw new Error('bad input');
      },
    });
    engine.register('broken', '1', async () => 'ran', {
      onEvent: [
        {
          event: runCompletedEvent('ingest'),
          where: () => {
            throw new Error('boom');
          },
        },
      ],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => events.filter((e) => e.type === 'run.trigger_failed').length === 2);

    expect(events.filter((e) => e.type === 'run.trigger_failed')).toEqual([
      expect.objectContaining({ runId: 'i1', name: 'strict', error: { message: 'bad input' } }),
      expect.objectContaining({ runId: 'i1', name: 'broken', error: { message: 'boom' } }),
    ]);
    expect((await store.getRun('i1'))?.tags?.sort()).toEqual([
      `${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}broken`,
      `${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}strict`,
    ]);
    expect(await engine.sweepLifecycleEvents(Date.now() + 60_000)).toBe(0);
  });

  it('tags a subscriber whose start throws as trigger_failed in the write that drops its owed tag', async () => {
    const { store, engine } = setup();
    const writes: Partial<WorkflowRun>[] = [];
    const updateRun = store.updateRun.bind(store);
    store.updateRun = async (id, patch) => {
      if (id === 'i1' && patch.tags && !patch.status) writes.push(patch);
      return updateRun(id, patch);
    };
    const createRun = store.createRun.bind(store);
    store.createRun = async (run) => {
      if (run.id.startsWith('evt:')) throw new Error('store full');
      return createRun(run);
    };
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'ran', {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => writes.length === 1);
    await settle();

    expect(writes).toEqual([{ tags: [`${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}refresh`] }]);
  });

  it('clears the trigger_failed tag when a republish starts the subscriber', async () => {
    const { store, engine } = setup();
    let reject = true;
    engine.register('ingest', '1', async () => 'ok');
    engine.register('strict', '1', async () => 'ran', {
      onEvent: [runCompletedEvent('ingest')],
      validateInput: () => {
        if (reject) throw new Error('bad input');
      },
    });

    await engine.start('ingest', {}, 'i1');
    await poll(async () =>
      Boolean(
        (await store.getRun('i1'))?.tags?.includes(`${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}strict`),
      ),
    );
    const failedRun = (await store.getRun('i1')) as WorkflowRun;
    expect(lifecycleEventOf(failedRun).tags).toEqual([]);

    reject = false;
    const result = await engine.republishLifecycle({ runId: 'i1', subscriber: 'strict' });
    expect(result).toMatchObject({ started: 1, failed: [] });
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:strict']);
  });
});

describe('lifecycle input mapping', () => {
  it('starts the subscriber with what input builds, and still links it to the source', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => ({ rows: 2 }));
    engine.register('refresh', '1', async (_ctx, input) => input, {
      onEvent: [
        {
          event: runCompletedEvent('ingest'),
          input: (e) => ({
            baseId: (e as WorkflowLifecycleEvent<{ baseId: string }>).input.baseId,
          }),
        },
      ],
    });

    await engine.start('ingest', { baseId: 'b1', big: 'x'.repeat(1000) }, 'i1');
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    await poll(async () => (await store.getRun(started))?.status === 'completed');

    const run = (await store.getRun(started)) as WorkflowRun;
    expect(run.input).toEqual({ baseId: 'b1' });
    expect(lifecycleSourceOf(run)).toEqual({ runId: 'i1', kind: 'completed' });
  });

  it('reads the triggered links from the run, on an engine that registers no subscriber', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.tags?.length === 1);

    const dashboard = new WorkflowEngine({ store });
    expect(await dashboard.triggeredRuns('i1')).toEqual(['evt:i1:completed:refresh']);
  });
});

describe('runDetailEtag with lifecycle links', () => {
  it('changes when the settled run records a triggered subscriber', () => {
    const run = {
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as WorkflowRun;
    const triggered = { ...run, tags: ['durable:triggered:refresh'] };
    expect(runDetailEtag(triggered, [], 50)).not.toBe(runDetailEtag(run, [], 50));
    expect(triggeredRunsOf(triggered)).toEqual(['evt:i1:completed:refresh']);
  });
});

describe('the coalesced tag', () => {
  it('names the subscribers and stays out of the event payload', () => {
    const tag = `${LIFECYCLE_COALESCED_TAG_PREFIX}digest`;
    expect(tag).toBe('durable:coalesced:digest');
    expect(isLifecycleTag(tag)).toBe(true);
    expect(coalescedSubscribersOf(['etl', tag, 'durable:triggered:refresh'])).toEqual(['digest']);
    const run: WorkflowRun = {
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      output: 'ok',
      tags: ['etl', tag],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    expect(lifecycleEventOf(run).tags).toEqual(['etl']);
  });
});
