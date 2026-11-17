import { NO_LIVE_WORKER, VERSION_UNDECLARED_TAG, WorkflowEngine } from './engine';
import type { WorkerDescriptor } from './handshake/index';
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
 * A tenant start (a {@link StartRunMessage} from a store-less tenant process) behaves like a start on
 * a standalone app: it is never lost while no tenant worker is live, it keeps its start options, and
 * a run whose tenant worker died mid-turn is re-driven instead of hanging.
 */

/** A broker fake: live groups that can change, optional descriptors, captured workflow turns. */
class TenantBroker implements Transport {
  readonly turns: WorkflowTask[] = [];
  live: string[] = [];
  descriptors: WorkerDescriptor[] = [];
  private startRun?: (msg: StartRunMessage) => Promise<void>;
  private decide?: (decision: WorkflowDecision) => Promise<void>;

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
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    this.startRun = handler;
  }
  /** Deliver a start-run, then let the in-process dispatcher take the run to where it rests. */
  async deliver(msg: StartRunMessage): Promise<void> {
    if (!this.startRun) throw new Error('no onStartRun consumer');
    await this.startRun(msg);
    if (this.store && msg.runId) await restOf(this.store, msg.runId);
  }
  store?: InMemoryStateStore;
  /** The tenant worker answers the last turn of `runId` with a completed decision. */
  async complete(runId: string, output: unknown): Promise<void> {
    const turn = [...this.turns].reverse().find((t) => t.runId === runId);
    if (!turn || !this.decide) throw new Error(`no turn for ${runId}`);
    await this.decide({ taskId: turn.taskId, runId, status: 'completed', commands: [], output });
  }
}

/** Wait until `runId` is neither `pending` nor `running` (the dispatcher runs a start async). */
async function restOf(store: InMemoryStateStore, runId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const run = await store.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${runId} never came to rest`);
}

function tenantWorker(name: string, group: string, version: string): WorkerDescriptor {
  return {
    instanceId: `w-${version}`,
    runtime: 'node',
    sdk: { name: 'durable-worker', version: '0.0.0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [name],
    steps: [],
    startedAt: 0,
    registrations: [{ name, version, group }],
  };
}

function setup(deps: { reconcileMs?: number; remoteAdvanceSilenceMs?: number } = {}) {
  let now = 1_000_000;
  const store = new InMemoryStateStore();
  const broker = new TenantBroker();
  broker.store = store;
  const engine = new WorkflowEngine({
    store,
    transport: broker,
    namespace: undefined,
    clock: () => now,
    ...deps,
  });
  return {
    store,
    broker,
    engine,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('tenant start — never lost while no tenant worker is live (item 2)', () => {
  it('parks the run blocked, keeps re-parking while nothing is live, and starts it once a worker is', async () => {
    const { store, broker, engine, advance } = setup();

    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: { n: 1 }, runId: 'r1' });

    // Was: `workflow invoice is not registered` thrown into a consumer that drops failed jobs.
    const parked = await store.getRun('r1');
    expect(parked?.status).toBe('blocked');
    expect(parked?.error?.code).toBe(NO_LIVE_WORKER);
    expect(parked?.namespace).toBe('acme');
    expect(parked?.tags).toContain(VERSION_UNDECLARED_TAG);

    // Due, still nothing live: re-parked further out, nothing dispatched, never dead-lettered.
    advance(10_000);
    await engine.resumeDueTimers();
    const reparked = await store.getRun('r1');
    expect(reparked?.status).toBe('blocked');
    expect(reparked?.wakeAt).toBeGreaterThan(1_010_000);
    expect(broker.turns).toEqual([]);

    // A redelivered start-run is a no-op: one run, still parked.
    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: { n: 1 }, runId: 'r1' });
    expect(await store.listRuns({})).toHaveLength(1);

    // The tenant worker boots, declaring version 3: the run starts there, on the declared version.
    broker.live = ['invoice@acme'];
    broker.descriptors = [tenantWorker('invoice', 'invoice@acme', '3')];
    advance(120_000);
    await engine.resumeDueTimers();
    expect(broker.turns.map((t) => [t.group, t.workflowVersion])).toEqual([['invoice@acme', '3']]);
    const started = await store.getRun('r1');
    expect(started?.workflowVersion).toBe('3');
    expect(started?.tags ?? []).not.toContain(VERSION_UNDECLARED_TAG);

    await broker.complete('r1', { ok: true });
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });

  it('starts at once, as before, when the tenant worker is already live', async () => {
    const { store, broker } = setup();
    broker.live = ['invoice@acme'];

    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'r2' });

    expect((await store.getRun('r2'))?.status).not.toBe('blocked');
    expect(broker.turns.map((t) => t.group)).toEqual(['invoice@acme']);
  });
});

describe('tenant start — start options survive the wire (item 3)', () => {
  it('stamps priority on the run and on every dispatched turn', async () => {
    const { store, broker } = setup();
    broker.live = ['invoice@acme'];

    await broker.deliver({
      tenant: 'acme',
      workflow: 'invoice',
      input: {},
      runId: 'p',
      priority: 7,
    });

    expect((await store.getRun('p'))?.priority).toBe(7);
    expect(broker.turns[0]?.priority).toBe(7);
  });

  it('delays the start until startAt', async () => {
    const { store, broker, engine, advance, now } = setup();
    broker.live = ['invoice@acme'];
    const startAt = now() + 60_000;

    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'd', startAt });

    const delayed = await store.getRun('d');
    expect(delayed?.status).toBe('suspended');
    expect(delayed?.wakeAt).toBe(startAt);
    expect(broker.turns).toEqual([]);

    advance(60_000);
    await engine.resumeDueTimers();
    expect(broker.turns.map((t) => t.runId)).toEqual(['d']);
  });

  it('a delayed start with no live worker waits for its startAt, then for the worker', async () => {
    const { store, broker, now } = setup();
    const startAt = now() + 60_000;

    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'dl', startAt });

    const parked = await store.getRun('dl');
    expect(parked?.status).toBe('blocked');
    expect(parked?.wakeAt).toBe(startAt);
  });

  it('pins the version: started only on a worker that declares it', async () => {
    const { store, broker, engine, advance } = setup();
    broker.live = ['invoice@acme'];
    broker.descriptors = [tenantWorker('invoice', 'invoice@acme', '2')];

    await broker.deliver({
      tenant: 'acme',
      workflow: 'invoice',
      input: {},
      runId: 'v2',
      version: '2',
    });
    expect((await store.getRun('v2'))?.workflowVersion).toBe('2');
    expect(broker.turns.map((t) => [t.runId, t.workflowVersion])).toEqual([['v2', '2']]);

    // Version 3 is not served yet: the run waits for it instead of starting on version 2.
    await broker.deliver({
      tenant: 'acme',
      workflow: 'invoice',
      input: {},
      runId: 'v3',
      version: '3',
    });
    const waiting = await store.getRun('v3');
    expect(waiting?.status).toBe('blocked');
    expect(waiting?.workflowVersion).toBe('3');
    advance(10_000);
    await engine.resumeDueTimers();
    expect(broker.turns.map((t) => t.runId)).toEqual(['v2']);

    // The version 3 worker rolls out: the pinned run starts there.
    broker.descriptors = [tenantWorker('invoice', 'invoice@acme', '3')];
    advance(120_000);
    await engine.resumeDueTimers();
    expect(broker.turns.map((t) => [t.runId, t.workflowVersion])).toEqual([
      ['v2', '2'],
      ['v3', '3'],
    ]);
  });

  it('enforces the concurrency quota, recording a rejected start as a failed run', async () => {
    const { store, broker } = setup();
    broker.live = ['invoice@acme'];
    const concurrency = { key: 'acme', limit: 1 };

    await broker.deliver({
      tenant: 'acme',
      workflow: 'invoice',
      input: {},
      runId: 'c1',
      concurrency,
    });
    await broker.deliver({
      tenant: 'acme',
      workflow: 'invoice',
      input: {},
      runId: 'c2',
      concurrency,
    });

    expect((await store.getRun('c1'))?.tags).toContain('concurrency:acme');
    const rejected = await store.getRun('c2');
    expect(rejected?.status).toBe('failed');
    expect(rejected?.error?.code).toBe('concurrency_limit');
    expect(broker.turns.map((t) => t.runId)).toEqual(['c1']);
  });

  it('stamps a refused start with the same quota tag as an admitted one', async () => {
    const { store, broker } = setup();
    broker.live = ['invoice@acme'];
    const concurrency = { key: 'acme', limit: 0 };

    await broker.deliver({
      tenant: 'acme',
      workflow: 'invoice',
      input: {},
      runId: 'z',
      concurrency,
    });

    expect((await store.getRun('z'))?.tags).toContain('concurrency:acme');
  });

  it('stores an input the control plane rejects as a failed run instead of throwing for redelivery', async () => {
    const { store, broker, engine } = setup();
    engine.register('strict', '1', async (_ctx, input) => input, {
      validateInput: (input) => {
        if ((input as { ok?: boolean }).ok !== true) throw new Error('ok must be true');
      },
    });

    await broker.deliver({ tenant: 'acme', workflow: 'strict', input: {}, runId: 'bad' });

    const run = await store.getRun('bad');
    expect(run?.status).toBe('failed');
    expect(run?.error?.code).toBe('invalid_input');
  });

  it('drops a message with no workflow name instead of throwing', async () => {
    const { store, broker } = setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await broker.deliver({ tenant: 'acme', input: {} } as unknown as StartRunMessage);

    expect(await store.listRuns({})).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('re-parks a waiting start for blockedPollMs when the liveness read fails', async () => {
    const { store, broker, engine, advance, now } = setup();
    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'outage' });
    broker.listWorkerGroups = async () => {
      throw new Error('redis down');
    };

    advance(10_000);
    await engine.resumeDueTimers();

    // Not left due (re-read on every poll of the outage), but looked at again shortly.
    expect((await store.getRun('outage'))?.wakeAt).toBe(now() + 5_000);
  });

  it('a message from an older tenant (no start options) starts exactly as before', async () => {
    const { store, broker } = setup();
    broker.live = ['invoice@acme'];

    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'old' });

    const run = await store.getRun('old');
    expect(run?.priority).toBeUndefined();
    expect(run?.workflowVersion).toBe('1');
    expect(broker.turns.map((t) => t.runId)).toEqual(['old']);
  });
});

describe('dispatched turns are re-driven when their worker dies (item 6)', () => {
  it('stamps a reconcileMs re-drive deadline on a dispatched turn, and re-dispatches it once lapsed', async () => {
    const { store, broker, engine, advance, now } = setup({ reconcileMs: 30_000 });
    broker.live = ['invoice@acme'];

    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'stall' });
    const suspended = await store.getRun('stall');
    // Was `undefined` without `remoteAdvanceSilenceMs`: nothing would ever re-drive the turn.
    expect(suspended?.wakeAt).toBe(now() + 30_000);

    // The worker died holding the turn: no decision, no heartbeat. Past the window it is re-sent.
    advance(31_000);
    await engine.resumeDueTimers();
    expect(broker.turns).toHaveLength(2);
    expect(broker.turns[1]?.taskId).not.toBe(broker.turns[0]?.taskId);

    await broker.complete('stall', 'done');
    expect((await store.getRun('stall'))?.status).toBe('completed');
  });

  it('an explicit remoteAdvanceSilenceMs still wins, and reconcileMs: 0 keeps the old unbounded wait', async () => {
    const explicit = setup({ reconcileMs: 30_000, remoteAdvanceSilenceMs: 5_000 });
    explicit.broker.live = ['invoice@acme'];
    await explicit.broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'e' });
    expect((await explicit.store.getRun('e'))?.wakeAt).toBe(explicit.now() + 5_000);

    const off = setup({ reconcileMs: 0 });
    off.broker.live = ['invoice@acme'];
    await off.broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'o' });
    expect((await off.store.getRun('o'))?.wakeAt).toBeUndefined();
  });

  it('backs off a due turn whose worker is gone instead of re-trying it every poll', async () => {
    const { store, broker, engine, advance } = setup({ reconcileMs: 30_000 });
    broker.live = ['invoice@acme'];
    await broker.deliver({ tenant: 'acme', workflow: 'invoice', input: {}, runId: 'gone' });
    broker.live = [];
    const getRun = vi.spyOn(store, 'tryLockRun');

    advance(31_000);
    await engine.resumeDueTimers();
    const tries = getRun.mock.calls.length;
    expect(tries).toBe(1);
    // A second poll a second later does not lease (and log) the same unresolvable run again.
    advance(1_000);
    await engine.resumeDueTimers();
    expect(getRun.mock.calls.length).toBe(tries);

    // The worker comes back: past the back-off the turn is re-sent and the run finishes.
    broker.live = ['invoice@acme'];
    advance(10_000);
    await engine.resumeDueTimers();
    expect(broker.turns).toHaveLength(2);
    await broker.complete('gone', 'done');
    expect((await store.getRun('gone'))?.status).toBe('completed');
  });
});
