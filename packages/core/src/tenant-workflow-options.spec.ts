import { WorkflowEngine } from './engine';
import { eventPrefix, eventToken } from './events';
import type { WorkerDescriptor, WorkflowRegistration } from './handshake/index';
import type {
  RemoteTask,
  StartRunMessage,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowTask,
} from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * `@Workflow` options declared only on a tenant (item 9), dead-letter routes it announces (item 10)
 * and its `signalWithStart`/`publishEvent` run requests (item 11), as a control plane that knows the
 * tenant's workflows by name alone applies them.
 */

class TenantBroker implements Transport {
  readonly turns: WorkflowTask[] = [];
  live: string[] = [];
  descriptors: WorkerDescriptor[] = [];
  private startRun?: (msg: StartRunMessage) => Promise<void>;
  private decide?: (decision: WorkflowDecision) => Promise<void>;
  store?: InMemoryStateStore;

  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(): void {}
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.turns.push(task);
  }
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decide = handler;
  }
  async listWorkerGroups(): Promise<string[]> {
    return this.live;
  }
  async readWorkerDescriptors(group: string): Promise<WorkerDescriptor[]> {
    return this.descriptors.filter((d) => d.registrations?.some((r) => r.group === group));
  }
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    this.startRun = handler;
  }
  async deliver(msg: StartRunMessage): Promise<void> {
    if (!this.startRun) throw new Error('no onStartRun consumer');
    await this.startRun(msg);
    if (this.store && msg.runId) await restOf(this.store, msg.runId);
  }
  /** The tenant worker answers the last turn of `runId`. */
  async answer(runId: string, decision: Partial<WorkflowDecision>): Promise<void> {
    const turn = [...this.turns].reverse().find((t) => t.runId === runId);
    if (!turn || !this.decide) throw new Error(`no turn for ${runId}`);
    await this.decide({
      taskId: turn.taskId,
      runId,
      status: 'completed',
      commands: [],
      ...decision,
    } as WorkflowDecision);
  }
}

async function restOf(store: InMemoryStateStore, runId: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const run = await store.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${runId} never came to rest`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function worker(
  instanceId: string,
  startedAt: number,
  registrations: WorkflowRegistration[],
): WorkerDescriptor {
  return {
    instanceId,
    runtime: 'node',
    sdk: { name: 'durable-worker', version: '0.0.0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: registrations.map((r) => r.name),
    steps: [],
    startedAt,
    registrations,
  };
}

function setup() {
  let now = 1_000_000;
  const store = new InMemoryStateStore();
  const broker = new TenantBroker();
  broker.store = store;
  const engine = new WorkflowEngine({
    store,
    transport: broker,
    namespace: undefined,
    clock: () => now,
    workerDescriptorCacheMs: 0,
  });
  return {
    store,
    broker,
    engine,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('announced @Workflow options on a convention-served tenant workflow (item 9)', () => {
  it('stamps the announced tags and admits runs one key at a time with the starter-evaluated singleton key', async () => {
    const { store, broker } = setup();
    broker.live = ['invoice@acme'];
    broker.descriptors = [
      worker('w1', 1, [
        {
          name: 'invoice',
          version: '1',
          group: 'invoice@acme',
          options: { tags: ['billing'], singleton: { limit: 1 } },
        },
      ]),
    ];
    const singleton = { key: 'customer-7' };
    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'a', singleton });
    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'b', singleton });

    const a = await store.getRun('a');
    const b = await store.getRun('b');
    expect(a?.tags).toEqual(expect.arrayContaining(['billing', 'singleton:acme/customer-7']));
    // The key is namespaced: another tenant's `customer-7` is another slot.
    expect(b?.tags).toContain('singleton:acme/customer-7');
    // One turn dispatched: the second run waits its turn behind the first.
    expect(broker.turns.map((t) => t.runId)).toEqual(['a']);
    expect(b?.status).toBe('suspended');

    // Another tenant's run with the same key is not held behind acme's.
    broker.live.push('invoice@globex');
    broker.descriptors.push(
      worker('w2', 1, [
        {
          name: 'invoice',
          version: '1',
          group: 'invoice@globex',
          options: { singleton: { limit: 1 } },
        },
      ]),
    );
    await broker.deliver({
      tenant: 'globex',
      workflow: 'invoice',
      input: {},
      runId: 'g',
      singleton,
    });
    expect(broker.turns.map((t) => t.runId)).toEqual(['a', 'g']);
  });

  it('wakes up to the announced limit of waiters when a convention singleton run frees its slot', async () => {
    const { store, broker, engine } = setup();
    broker.live = ['invoice@acme'];
    broker.descriptors = [
      worker('w1', 1, [
        {
          name: 'invoice',
          version: '1',
          group: 'invoice@acme',
          options: { singleton: { limit: 2 } },
        },
      ]),
    ];
    const singleton = { key: 'k', limit: 2 };
    for (const id of ['a', 'b', 'c', 'd']) {
      await broker.deliver({
        tenant: 'acme',
        workflow: 'invoice',
        input: {},
        runId: id,
        singleton,
      });
    }
    expect(broker.turns.map((t) => t.runId).sort()).toEqual(['a', 'b']);
    // A cancel frees a slot and wakes the oldest `limit` suspended runs of the key (notify-on-release):
    // with the announced limit 2 that reaches `c` now; read as limit 1 it would only re-wake `b`
    // and leave `c` to its retry timer.
    await engine.cancel('a');
    await settle();
    expect(broker.turns.map((t) => t.runId)).toContain('c');
    expect((await store.getRun('c'))?.tags).toContain('durable:singleton:admitted');
  });

  it('a pinned registration on the control plane wins over the announced options', async () => {
    const { store, broker, engine } = setup();
    broker.live = ['invoice@acme'];
    broker.descriptors = [
      worker('w1', 1, [
        { name: 'invoice', version: '1', group: 'invoice@acme', options: { tags: ['tenant'] } },
      ]),
    ];
    engine.register('invoice', '1', async () => 'local', { tags: ['control-plane'] });
    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'r' });
    const run = await store.getRun('r');
    expect(run?.tags).toContain('control-plane');
    expect(run?.tags ?? []).not.toContain('tenant');
  });

  it('applies the options of the worker that started last when replicas disagree (newest deploy wins)', async () => {
    const { store, broker } = setup();
    broker.live = ['invoice@acme'];
    broker.descriptors = [
      worker('old', 10, [
        { name: 'invoice', version: '1', group: 'invoice@acme', options: { tags: ['v-old'] } },
      ]),
      worker('new', 20, [
        { name: 'invoice', version: '1', group: 'invoice@acme', options: { tags: ['v-new'] } },
      ]),
    ];
    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'r' });
    const run = await store.getRun('r');
    expect(run?.tags).toContain('v-new');
    expect(run?.tags ?? []).not.toContain('v-old');
  });

  it('cancels a run that outlives the executionTimeout its workers announce', async () => {
    const { store, broker, engine, advance } = setup();
    broker.live = ['invoice@acme'];
    broker.descriptors = [
      worker('w1', 1, [
        {
          name: 'invoice',
          version: '1',
          group: 'invoice@acme',
          options: { executionTimeoutMs: 60_000 },
        },
      ]),
    ];
    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'r' });
    const createdAt = (await store.getRun('r'))?.createdAt.getTime() ?? 0;
    await store.updateRun('r', { createdAt: new Date(createdAt - 61_000) });
    advance(61_000);
    await engine.sweepTimeouts(Date.now() + 1);
    const run = await store.getRun('r');
    expect(run?.status).toBe('cancelled');
    expect(run?.error?.code).toBe('execution_timeout');
  });

  it('a start parked while no worker is live keeps its singleton key, and is gated once one is', async () => {
    const { store, broker, engine, advance } = setup();
    const singleton = { key: 'k' };
    await broker.deliver({
      tenant: 'acme',
      workflow: 'invoice',
      input: {},
      runId: 'p1',
      singleton,
    });
    await broker.deliver({
      tenant: 'acme',
      workflow: 'invoice',
      input: {},
      runId: 'p2',
      singleton,
    });
    expect((await store.getRun('p1'))?.tags).toContain('singleton:acme/k');
    broker.live = ['invoice@acme'];
    broker.descriptors = [
      worker('w1', 1, [
        { name: 'invoice', version: '1', group: 'invoice@acme', options: { singleton: {} } },
      ]),
    ];
    advance(120_000);
    await engine.resumeDueTimers();
    // One of the two starts once a worker is live; the other is held behind it by the key. Both
    // resume together, so both can lose the race for the key and be held with a short retry; the
    // clock is fake, so move it on and resume what is due until one is admitted.
    for (let i = 0; i < 20 && broker.turns.length === 0; i++) {
      for (let j = 0; j < 10 && broker.turns.length === 0; j++) await settle();
      if (broker.turns.length > 0) break;
      advance(5_000);
      await engine.resumeDueTimers();
    }
    await settle();
    expect(new Set(broker.turns.map((t) => t.runId)).size).toBe(1);
    const held = ['p1', 'p2'].find((id) => !broker.turns.some((t) => t.runId === id));
    expect((await store.getRun(held as string))?.tags).toContain('durable:singleton:tracked');
  });
});

describe('announced dead-letter route (item 10)', () => {
  it('starts the tenant-announced handler in the dead run namespace, as dlq:<runId>', async () => {
    const { store, broker, engine } = setup();
    broker.live = ['invoice@acme', 'invoice.dlq@acme'];
    broker.descriptors = [
      worker('w1', 1, [
        { name: 'invoice', version: '1', group: 'invoice@acme', deadLetter: 'invoice.dlq' },
        { name: 'invoice.dlq', version: '1', group: 'invoice.dlq@acme' },
      ]),
    ];
    const deadEngine = new WorkflowEngine({
      store,
      transport: broker,
      namespace: undefined,
      maxRecoveryAttempts: 0,
      workerDescriptorCacheMs: 0,
    });
    await store.createRun({
      id: 'poison',
      workflow: 'invoice',
      workflowVersion: '1',
      status: 'running',
      namespace: 'acme',
      input: { n: 1 },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await deadEngine.recoverIncomplete();
    expect((await store.getRun('poison'))?.status).toBe('dead');
    await restOf(store, 'dlq:poison');
    const dlq = await store.getRun('dlq:poison');
    expect(dlq?.workflow).toBe('invoice.dlq');
    expect(dlq?.namespace).toBe('acme');
    expect(dlq?.input).toMatchObject({ deadRunId: 'poison', workflow: 'invoice', input: { n: 1 } });
    expect(
      broker.turns.some((t) => t.runId === 'dlq:poison' && t.group === 'invoice.dlq@acme'),
    ).toBe(true);
    expect(await engine.announcedDeadLetter({ ...(dlq as never), workflow: 'invoice' })).toBe(
      'invoice.dlq',
    );
  });

  it('routes nothing for a workflow registered on the control plane', async () => {
    const { broker, engine } = setup();
    broker.live = ['invoice@acme'];
    broker.descriptors = [
      worker('w1', 1, [
        { name: 'invoice', version: '1', group: 'invoice@acme', deadLetter: 'invoice.dlq' },
      ]),
    ];
    engine.register('invoice', '1', async () => 1);
    const run = {
      id: 'x',
      workflow: 'invoice',
      workflowVersion: '1',
      status: 'dead' as const,
      namespace: 'acme',
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(await engine.announcedDeadLetter(run)).toBeUndefined();
  });
});

describe('tenant signalWithStart and publishEvent (item 11)', () => {
  it('signalWithStart starts the run in the tenant namespace and buffers a run-scoped token', async () => {
    const { store, broker, engine } = setup();
    broker.live = ['counter@acme'];
    broker.descriptors = [
      worker('w1', 1, [{ name: 'counter', version: '1', group: 'counter@acme' }]),
    ];
    const out = await engine.signalWithStartForTenant(
      { tenant: 'acme', workflow: 'counter', input: {}, runId: 'counter-1' },
      'acme',
      {},
      { token: 'counter-1:add', payload: 2 },
    );
    expect(out).toEqual({ runId: 'counter-1', signalled: true });
    expect((await store.getRun('counter-1'))?.namespace).toBe('acme');
    expect(await store.takeBufferedSignal('counter-1:add')).toEqual({ payload: 2 });
  });

  it('signalWithStart signals nothing for a start the control plane refused', async () => {
    const { store, broker, engine } = setup();
    broker.live = ['counter@acme'];
    broker.descriptors = [
      worker('w1', 1, [{ name: 'counter', version: '1', group: 'counter@acme' }]),
    ];
    const out = await engine.signalWithStartForTenant(
      {
        tenant: 'acme',
        workflow: 'counter',
        input: {},
        runId: 'counter-3',
        concurrency: { key: 'none', limit: 0 },
      },
      'acme',
      {},
      { token: 'counter-3:add', payload: 1 },
    );
    expect(out).toEqual({ runId: 'counter-3', signalled: false });
    expect((await store.getRun('counter-3'))?.error?.code).toBe('concurrency_limit');
    expect(await store.takeBufferedSignal('counter-3:add')).toBeNull();
  });

  it('signalWithStart buffers nothing on a token that does not name the run', async () => {
    const { store, broker, engine } = setup();
    broker.live = ['counter@acme'];
    broker.descriptors = [
      worker('w1', 1, [{ name: 'counter', version: '1', group: 'counter@acme' }]),
    ];
    const out = await engine.signalWithStartForTenant(
      { tenant: 'acme', workflow: 'counter', input: {}, runId: 'counter-2' },
      'acme',
      {},
      { token: 'shared-token', payload: 1 },
    );
    expect(out.signalled).toBe(false);
    expect(await store.takeBufferedSignal('shared-token')).toBeNull();
  });

  it('publishEventForTenant resumes only the requester namespace waiting runs and buffers nothing', async () => {
    const { store, engine } = setup();
    engine.register('w', '1', async () => 'resumed');
    const seed = async (id: string, namespace: string) => {
      await store.createRun({
        id,
        workflow: 'w',
        workflowVersion: '1',
        status: 'suspended',
        namespace,
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await store.putSignalWaiter({
        token: eventToken('paid', undefined, id, 0),
        runId: id,
        seq: 0,
      });
    };
    await seed('mine', 'acme');
    await seed('theirs', 'globex');
    const waiters = await store.listSignalWaiters(eventPrefix('paid'));
    expect(waiters).toHaveLength(2);
    const touched = await engine.publishEventForTenant('paid', { ok: true }, 'acme');
    expect(touched).toBe(1);
    const left = await store.listSignalWaiters(eventPrefix('paid'));
    expect(left.map((w) => w.runId)).toEqual(['theirs']);
    expect(await engine.publishEventForTenant('nobody', {}, 'acme')).toBe(0);
  });
});
