import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkerDescriptor } from './handshake/index';
import type { RemoteTask, Transport, WorkflowRun, WorkflowTask } from './interfaces';
import {
  LIFECYCLE_ORPHAN_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_TRACE_TAG_PREFIX,
  lifecycleRunId,
  parseLifecycleEvent,
  runCompletedEvent,
  runFailedEvent,
} from './lifecycle-events';
import { runWaitToken } from './run-wait';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function poll(fn: () => Promise<boolean> | boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const settle = () => new Promise((r) => setTimeout(r, 30));

/** A Python worker's descriptor: one workflow, served on its own queue, subscribing to `subscribes`. */
function pythonWorker(name: string, subscribes: string[]): WorkerDescriptor {
  return {
    instanceId: `py-${name}`,
    runtime: 'python',
    sdk: { name: 'durable-worker', version: '1' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [name],
    steps: [],
    registrations: [{ name, group: name, subscribes }],
    startedAt: 0,
  };
}

/** A fleet transport: serves the descriptors and live groups given, and records workflow turns. */
function fleet(descriptors: WorkerDescriptor[], liveGroups: string[]) {
  const tasks: WorkflowTask[] = [];
  const transport: Transport = {
    async dispatch(_task: RemoteTask): Promise<void> {},
    onResult(): void {},
    onHeartbeat(): void {},
    async listWorkerGroups(): Promise<string[]> {
      return liveGroups;
    },
    async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
      return descriptors;
    },
    async readWorkerDescriptors(group: string): Promise<WorkerDescriptor[]> {
      return descriptors.filter((d) => d.registrations?.some((r) => r.group === group));
    },
    async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
      tasks.push(task);
    },
  };
  return { transport, tasks };
}

describe('subscribers only live workers announce (a Python @workflow(on_workflow_completed=...))', () => {
  it('starts an announced remote subscriber by name when the run settles, with the payload as input', async () => {
    const store = new InMemoryStateStore();
    const { transport, tasks } = fleet(
      [pythonWorker('notify', [runCompletedEvent('ingest')])],
      ['notify'],
    );
    const engine = new WorkflowEngine({ store, transport });
    engine.register('ingest', '1', async () => ({ rows: 3 }));

    await engine.start('ingest', { base: 'b1' }, 'i1');
    const started = lifecycleRunId('i1', 'completed', 'notify');
    await poll(() => tasks.length === 1);
    expect(tasks[0]).toMatchObject({ runId: started, workflow: 'notify', group: 'notify' });
    expect((await store.getRun(started))?.input).toMatchObject({
      runId: 'i1',
      workflow: 'ingest',
      status: 'completed',
      input: { base: 'b1' },
      output: { rows: 3 },
    });
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:notify']);
  });

  it('starts it on a failed run too, and only for the kind it subscribes to', async () => {
    const store = new InMemoryStateStore();
    const { transport, tasks } = fleet(
      [pythonWorker('alert', [runFailedEvent('ingest')])],
      ['alert'],
    );
    const engine = new WorkflowEngine({ store, transport });
    engine.register('ingest', '1', async (_ctx, input: { fail: boolean }) => {
      if (input.fail) throw new Error('boom');
      return 'ok';
    });

    await engine.start('ingest', { fail: false }, 'ok1');
    await poll(async () => (await store.getRun('ok1'))?.status === 'completed');
    await engine.start('ingest', { fail: true }, 'bad1', {});
    await poll(() => tasks.length === 1, 3000);
    expect(tasks.map((t) => t.runId)).toEqual([lifecycleRunId('bad1', 'failed', 'alert')]);
  });

  it('leaves a subscriber a Node engine announces to that engine, which applies its where/input', async () => {
    const store = new InMemoryStateStore();
    const nodeEngine: WorkerDescriptor = {
      ...pythonWorker('notify', [runCompletedEvent('ingest')]),
      instanceId: 'node-notify',
      runtime: 'node',
    };
    const { transport, tasks } = fleet([nodeEngine], ['notify']);
    const engine = new WorkflowEngine({ store, transport });
    engine.register('ingest', '1', async () => 'ok');

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    expect(tasks).toEqual([]);
    expect(await store.getRun(lifecycleRunId('i1', 'completed', 'notify'))).toBeNull();
    expect((await store.getRun('i1'))?.tags).toEqual(
      expect.arrayContaining([LIFECYCLE_PENDING_TAG, `${LIFECYCLE_OWED_TAG_PREFIX}notify`]),
    );
  });

  it('does not start it twice when the same subscriber is also registered locally', async () => {
    const store = new InMemoryStateStore();
    const { transport, tasks } = fleet(
      [pythonWorker('notify', [runCompletedEvent('ingest')])],
      ['notify'],
    );
    const engine = new WorkflowEngine({ store, transport });
    let runs = 0;
    engine.register('ingest', '1', async () => 'ok');
    engine.register('notify', '1', async () => void runs++, {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.start('ingest', {}, 'i1');
    const started = lifecycleRunId('i1', 'completed', 'notify');
    await poll(async () => (await store.getRun(started))?.status === 'completed');
    await settle();
    expect(await engine.sweepLifecycleEvents(Date.now() + 60_000)).toBe(0);
    expect(runs).toBe(1);
    expect(tasks).toEqual([]);
  });

  it('leaves the event owed, without reporting a failure, while no live group serves the subscriber', async () => {
    const store = new InMemoryStateStore();
    const live: string[] = [];
    const { transport, tasks } = fleet(
      [pythonWorker('notify', [runCompletedEvent('ingest')])],
      live,
    );
    const engine = new WorkflowEngine({ store, transport });
    const failures: string[] = [];
    engine.subscribe((e) => {
      if (e.type === 'run.trigger_failed') failures.push(e.name ?? '');
    });
    engine.register('ingest', '1', async () => 'ok');

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual([
      LIFECYCLE_PENDING_TAG,
      `${LIFECYCLE_OWED_TAG_PREFIX}notify`,
    ]);
    expect(failures).toEqual([]);

    live.push('notify');
    expect(await engine.sweepLifecycleEvents(Date.now() + 60_000)).toBe(1);
    await poll(() => tasks.length === 1);
    expect(tasks.map((t) => t.runId)).toEqual([lifecycleRunId('i1', 'completed', 'notify')]);
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:notify']);
  });

  it('starts an announced subscriber of a plain event on publishEvent', async () => {
    const store = new InMemoryStateStore();
    const { transport, tasks } = fleet([pythonWorker('on-order', ['order.placed'])], ['on-order']);
    const engine = new WorkflowEngine({ store, transport });

    expect(await engine.publishEvent('order.placed', { id: 7 }, { id: 'e1' })).toBe(1);
    await poll(() => tasks.length === 1);
    expect(tasks[0]).toMatchObject({ runId: 'evt:e1:on-order', workflow: 'on-order' });
  });

  it('republishes to an announced remote subscriber', async () => {
    const store = new InMemoryStateStore();
    const { transport, tasks } = fleet(
      [pythonWorker('notify', [runCompletedEvent('ingest')])],
      ['notify'],
    );
    const engine = new WorkflowEngine({ store, transport });
    await store.createRun({
      id: 'old',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      output: 'ok',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    expect(await engine.republishLifecycle({ runId: 'old' })).toEqual({
      runs: 1,
      started: 1,
      failed: [],
    });
    await poll(() => tasks.length === 1);
    expect(tasks.map((t) => t.runId)).toEqual([lifecycleRunId('old', 'completed', 'notify')]);
  });
});

describe('workflowLifecycle: who starts whom', () => {
  it('lists local and announced subscribers, both ways, with what each subscription does', async () => {
    const store = new InMemoryStateStore();
    const { transport } = fleet(
      [
        pythonWorker('notify', [runCompletedEvent('ingest'), runFailedEvent('ingest')]),
        pythonWorker('ingest', [runCompletedEvent('upload')]),
      ],
      [],
    );
    const engine = new WorkflowEngine({ store, transport });
    engine.register('refresh', '1', async () => 'ok', {
      onEvent: [
        {
          event: runCompletedEvent('ingest'),
          where: () => true,
          input: (p) => p,
        },
      ],
      eventBatch: { mode: 'debounce', windowMs: 1000, key: (i) => String(i) },
    });
    engine.register('ingest', '1', async () => 'ok', { onEvent: [runFailedEvent('crawl')] });

    expect(await engine.workflowLifecycle('ingest')).toEqual({
      workflow: 'ingest',
      startsOnSettle: [
        {
          workflow: 'notify',
          kind: 'completed',
          local: false,
          announced: true,
          where: false,
          input: false,
        },
        {
          workflow: 'notify',
          kind: 'failed',
          local: false,
          announced: true,
          where: false,
          input: false,
        },
        {
          workflow: 'refresh',
          kind: 'completed',
          local: true,
          announced: false,
          where: true,
          input: true,
          coalesce: { mode: 'debounce', keyed: true },
        },
      ],
      startedBy: [
        {
          workflow: 'crawl',
          kind: 'failed',
          local: true,
          announced: false,
          where: false,
          input: false,
        },
        {
          workflow: 'upload',
          kind: 'completed',
          local: false,
          announced: true,
          where: false,
          input: false,
        },
      ],
    });
    expect(await engine.workflowLifecycle('nobody')).toEqual({
      workflow: 'nobody',
      startsOnSettle: [],
      startedBy: [],
    });
  });

  it('parses lifecycle event names and nothing else', () => {
    expect(parseLifecycleEvent('run.completed:ingest')).toEqual({
      workflow: 'ingest',
      kind: 'completed',
    });
    expect(parseLifecycleEvent('run.failed:a:b')).toEqual({ workflow: 'a:b', kind: 'failed' });
    expect(parseLifecycleEvent('run.completed:')).toBeUndefined();
    expect(parseLifecycleEvent('order.placed')).toBeUndefined();
  });
});

describe('the lifecycle sweep is not starved by runs it cannot act on', () => {
  const marked = (id: string, tags: string[], at: number): WorkflowRun => ({
    id,
    workflow: 'ingest',
    workflowVersion: '1',
    status: 'completed',
    input: {},
    tags,
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });

  it('reaches a run it can publish behind a full page of runs owed only elsewhere', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('mine', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    for (let i = 0; i < 25; i += 1) {
      await store.createRun(
        marked(`elsewhere-${i}`, [LIFECYCLE_PENDING_TAG, `${LIFECYCLE_OWED_TAG_PREFIX}theirs`], 0),
      );
    }
    await store.createRun(
      marked('crashed', [LIFECYCLE_PENDING_TAG, `${LIFECYCLE_OWED_TAG_PREFIX}mine`], 0),
    );

    expect(await engine.sweepLifecycleEvents(60_000, 10)).toBe(1);
    await poll(
      async () => (await store.getRun('evt:crashed:completed:mine'))?.status === 'completed',
    );
    expect((await store.getRun('crashed'))?.tags).toEqual(['durable:triggered:mine']);
    expect((await store.getRun('elsewhere-0'))?.tags).toContain(
      `${LIFECYCLE_OWED_TAG_PREFIX}theirs`,
    );
  });

  it('stops once it has acted on limit runs', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('mine', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    for (let i = 0; i < 5; i += 1) {
      await store.createRun(
        marked(`r${i}`, [LIFECYCLE_PENDING_TAG, `${LIFECYCLE_OWED_TAG_PREFIX}mine`], 0),
      );
    }

    expect(await engine.sweepLifecycleEvents(60_000, 2)).toBe(2);
    expect(await engine.sweepLifecycleEvents(60_000, 10)).toBe(3);
  });

  it('drops orphans behind a page of runs it cannot act on', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport: fleet([pythonWorker('theirs', [runCompletedEvent('ingest')])], []).transport,
    });
    for (let i = 0; i < 12; i += 1) {
      await store.createRun(
        marked(`elsewhere-${i}`, [LIFECYCLE_PENDING_TAG, `${LIFECYCLE_OWED_TAG_PREFIX}theirs`], 0),
      );
    }
    await store.createRun(
      marked('orphaned', [LIFECYCLE_PENDING_TAG, `${LIFECYCLE_OWED_TAG_PREFIX}removed`], 0),
    );

    await engine.sweepLifecycleEvents(LIFECYCLE_ORPHAN_MS + 1, 5);
    expect((await store.getRun('orphaned'))?.tags).toEqual(['durable:trigger_failed:removed']);
  });

  it('delivers a settled run wait behind a page of waits on runs still in flight', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wait', '1', async (ctx) => (await ctx.waitForRun('done')).output);
    for (let i = 0; i < 15; i += 1) {
      await store.createRun({ ...marked(`busy-${i}`, [], 0), status: 'running' });
      await store.putSignalWaiter({
        token: runWaitToken(`busy-${i}`, `w-${i}`, 0),
        runId: `w-${i}`,
        seq: 0,
      });
    }
    await store.createRun({ ...marked('done', [], 0), output: 'ok' });
    await store.createRun({ ...marked('waiter', [], 0), status: 'suspended', workflow: 'wait' });
    await store.putSignalWaiter({
      token: runWaitToken('done', 'waiter', 0),
      runId: 'waiter',
      seq: 0,
    });

    expect(await engine.sweepRunWaits(5)).toBe(1);
    await poll(async () => (await store.getRun('waiter'))?.status === 'completed');
    expect((await store.getRun('waiter'))?.output).toBe('ok');
    expect(
      (await store.listSignalWaiters(runWaitToken('done', 'waiter', 0))).map((w) => w.token),
    ).toEqual([]);
  });
});

describe('the source run trace context', () => {
  it('records the settled run’s traceparent with the lifecycle marker and hands it to the subscriber’s run.started', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    engine.setRunTraceparent((runId) => (runId === 'i1' ? traceparent : undefined));
    const started: { runId: string; sourceTraceparent?: string | undefined }[] = [];
    engine.subscribe((e) => {
      if (e.type === 'run.started')
        started.push({ runId: e.runId, sourceTraceparent: e.sourceTraceparent });
    });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });

    await engine.start('ingest', {}, 'i1');
    const sub = lifecycleRunId('i1', 'completed', 'refresh');
    await poll(async () => (await store.getRun(sub))?.status === 'completed');
    await settle();

    expect((await store.getRun('i1'))?.tags).toEqual([
      `${LIFECYCLE_TRACE_TAG_PREFIX}${traceparent}`,
      'durable:triggered:refresh',
    ]);
    expect(started).toEqual([
      { runId: 'i1', sourceTraceparent: undefined },
      { runId: sub, sourceTraceparent: traceparent },
    ]);
    // The trace tag is bookkeeping: it is not in the event payload the subscriber gets.
    expect((await store.getRun(sub))?.input).not.toHaveProperty(
      'tags',
      expect.arrayContaining([expect.stringContaining(LIFECYCLE_TRACE_TAG_PREFIX)]),
    );
  });

  it('records nothing without a provider', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });

    await engine.start('ingest', {}, 'i1');
    await poll(
      async () =>
        (await store.getRun(lifecycleRunId('i1', 'completed', 'refresh')))?.status === 'completed',
    );
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:refresh']);
  });
});
