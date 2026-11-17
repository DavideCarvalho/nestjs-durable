import { NO_LIVE_WORKER, WorkflowEngine } from './engine';
import type { AnnouncedSchedule, WorkerDescriptor } from './handshake/index';
import type {
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowTask,
} from './interfaces';
import { ANNOUNCED_SCHEDULE_TAG, ScheduleClient, announcedScheduleId } from './schedules';
import { hmacTenantVerifier, signTenantToken } from './tenant-auth';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * Schedules a TENANT app declares are announced on its workers' descriptors; the control plane adopts
 * them as persisted schedules (namespaced by the app), keeps them in step with what the app's live
 * workers announce, and fires them through the tenant start path, so a window that comes due while
 * the app has no live worker waits for one instead of being lost.
 */

/** A broker fake: live descriptors and worker groups that can change, captured workflow turns. */
class Fleet implements Transport {
  descriptors: WorkerDescriptor[] = [];
  live: string[] = [];
  readonly turns: WorkflowTask[] = [];
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(): void {}
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.turns.push(task);
  }
  onDecision(_handler: (decision: WorkflowDecision) => Promise<void>): void {}
  async listWorkerGroups(): Promise<string[]> {
    return this.live;
  }
  async readWorkerDescriptors(group: string): Promise<WorkerDescriptor[]> {
    return this.descriptors.filter((d) => d.registrations?.some((r) => r.group === group));
  }
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
}

function worker(
  instanceId: string,
  tenant: string,
  items: AnnouncedSchedule[] | undefined,
  startedAt = 0,
): WorkerDescriptor {
  return {
    instanceId,
    runtime: 'node',
    sdk: { name: 'durable-worker', version: '0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: ['digest'],
    steps: [],
    registrations: [{ name: 'digest', version: '1', group: `digest@${tenant}` }],
    partition: tenant,
    startedAt,
    ...(items !== undefined ? { schedules: { tenant, items } } : {}),
  };
}

const digest: AnnouncedSchedule = { key: 'daily', workflow: 'digest', everyMs: 60_000 };

function controlPlane(opts: { clock?: () => number; verifySecret?: string } = {}) {
  const store = new InMemoryStateStore();
  const fleet = new Fleet();
  const engine = new WorkflowEngine({
    store,
    transport: fleet,
    namespace: undefined,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.verifySecret ? { verifyTenant: hmacTenantVerifier(opts.verifySecret) } : {}),
  });
  return { store, fleet, engine };
}

describe('adopting the schedules a tenant app announces', () => {
  it('adopts them under the app namespace, so two apps with the same key do not collide', async () => {
    const { engine, fleet } = controlPlane();
    fleet.descriptors = [worker('a-1', 'acme', [digest]), worker('b-1', 'beta', [digest])];

    await engine.syncAnnouncedSchedules();

    const all = await engine.schedules.list();
    expect(all.map((s) => s.id).sort()).toEqual(['app:acme:daily', 'app:beta:daily']);
    const acme = await engine.schedules.get(announcedScheduleId('acme', 'daily'));
    expect(acme).toMatchObject({
      namespace: 'acme',
      workflow: 'digest',
      everyMs: 60_000,
      catchup: 'latest',
      announcedKey: 'daily',
      paused: false,
      tags: [ANNOUNCED_SCHEDULE_TAG],
    });
  });

  it('is idempotent across replicas and syncs: the same set writes nothing', async () => {
    const { engine, fleet, store } = controlPlane();
    fleet.descriptors = [worker('a-1', 'acme', [digest]), worker('a-2', 'acme', [digest])];
    await engine.syncAnnouncedSchedules();
    const first = await store.getSchedule('app:acme:daily');

    const again = await engine.syncAnnouncedSchedules();
    expect(again.get('acme')).toEqual({
      adopted: [],
      restored: [],
      missing: [],
      withdrawn: [],
      invalid: [],
    });
    expect(await store.getSchedule('app:acme:daily')).toEqual(first);
    expect(await engine.schedules.list()).toHaveLength(1);
  });

  it("re-applies a changed definition; on disagreement the newest worker's (newer deploy) wins", async () => {
    const { engine, fleet } = controlPlane();
    fleet.descriptors = [worker('old', 'acme', [digest], 1_000)];
    await engine.syncAnnouncedSchedules();

    // A rolling deploy: the new pod (started later) announces a new cadence while the old one lives.
    fleet.descriptors = [
      worker('old', 'acme', [digest], 1_000),
      worker('new', 'acme', [{ ...digest, everyMs: 120_000, input: { v: 2 } }], 2_000),
    ];
    const sync = await engine.syncAnnouncedSchedules();
    expect(sync.get('acme')?.adopted).toEqual(['app:acme:daily']);
    expect(await engine.schedules.get('app:acme:daily')).toMatchObject({
      everyMs: 120_000,
      input: { v: 2 },
    });
  });

  it('keeps a pause made from the console across a changed definition', async () => {
    const { engine, fleet } = controlPlane();
    fleet.descriptors = [worker('a-1', 'acme', [digest])];
    await engine.syncAnnouncedSchedules();
    await engine.schedules.pause('app:acme:daily', 'ops');

    fleet.descriptors = [worker('a-1', 'acme', [{ ...digest, everyMs: 30_000 }])];
    await engine.syncAnnouncedSchedules();
    expect(await engine.schedules.get('app:acme:daily')).toMatchObject({
      paused: true,
      everyMs: 30_000,
    });

    // The app's own declared `paused` does apply, both ways.
    fleet.descriptors = [worker('a-1', 'acme', [{ ...digest, paused: true }])];
    await engine.syncAnnouncedSchedules();
    fleet.descriptors = [worker('a-1', 'acme', [digest])];
    await engine.syncAnnouncedSchedules();
    expect((await engine.schedules.get('app:acme:daily'))?.paused).toBe(false);
  });

  it('withdraws (pauses, never deletes) a schedule the app stopped announcing, after the grace period', async () => {
    let now = 1_000_000;
    const { engine, fleet } = controlPlane({ clock: () => now });
    fleet.descriptors = [worker('a-1', 'acme', [digest, { ...digest, key: 'weekly' }])];
    await engine.syncAnnouncedSchedules({ graceMs: 60_000 });

    // The next deploy no longer declares `weekly`.
    fleet.descriptors = [worker('a-2', 'acme', [digest])];
    const first = await engine.syncAnnouncedSchedules({ graceMs: 60_000 });
    expect(first.get('acme')?.missing).toEqual(['app:acme:weekly']);
    expect(await engine.schedules.get('app:acme:weekly')).toMatchObject({
      paused: false,
      unannouncedSince: new Date(now),
    });

    now += 59_000;
    await engine.syncAnnouncedSchedules({ graceMs: 60_000 });
    expect((await engine.schedules.get('app:acme:weekly'))?.paused).toBe(false);

    now += 2_000;
    const late = await engine.syncAnnouncedSchedules({ graceMs: 60_000 });
    expect(late.get('acme')?.withdrawn).toEqual(['app:acme:weekly']);
    const withdrawn = await engine.schedules.get('app:acme:weekly');
    expect(withdrawn).toMatchObject({ paused: true, withdrawnAt: new Date(now) });
    expect(withdrawn?.note).toMatch(/no longer announces/);
    expect((await engine.schedules.get('app:acme:daily'))?.paused).toBe(false);

    // A rollback announces it again: it is resumed, its history kept.
    fleet.descriptors = [worker('a-3', 'acme', [digest, { ...digest, key: 'weekly' }])];
    const back = await engine.syncAnnouncedSchedules({ graceMs: 60_000 });
    expect(back.get('acme')?.restored).toEqual(['app:acme:weekly']);
    const restored = await engine.schedules.get('app:acme:weekly');
    expect(restored?.paused).toBe(false);
    expect(restored?.withdrawnAt).toBeUndefined();
    expect(restored?.unannouncedSince).toBeUndefined();
  });

  it("keeps an operator's note across a withdrawal and a changed definition", async () => {
    let now = 1_000_000;
    const { engine, fleet } = controlPlane({ clock: () => now });
    fleet.descriptors = [worker('a-1', 'acme', [digest])];
    await engine.syncAnnouncedSchedules({ graceMs: 1_000 });
    await engine.schedules.pause('app:acme:daily', 'paused by ops: ledger migration');

    fleet.descriptors = [worker('a-2', 'acme', [])];
    await engine.syncAnnouncedSchedules({ graceMs: 1_000 });
    now += 2_000;
    await engine.syncAnnouncedSchedules({ graceMs: 1_000 });
    expect((await engine.schedules.get('app:acme:daily'))?.note).toMatch(/no longer announces/);

    // Announced again: the withdrawal note goes, the operator's comes back (and so does its pause).
    fleet.descriptors = [worker('a-3', 'acme', [digest])];
    await engine.syncAnnouncedSchedules({ graceMs: 1_000 });
    expect(await engine.schedules.get('app:acme:daily')).toMatchObject({
      paused: true,
      note: 'paused by ops: ledger migration',
    });

    // A changed definition keeps the note too.
    fleet.descriptors = [worker('a-3', 'acme', [{ ...digest, everyMs: 30_000 }])];
    await engine.syncAnnouncedSchedules({ graceMs: 1_000 });
    expect((await engine.schedules.get('app:acme:daily'))?.note).toBe(
      'paused by ops: ledger migration',
    );
  });

  it('a withdrawal note does not outlive a rollback that changed the definition', async () => {
    let now = 1_000_000;
    const { engine, fleet } = controlPlane({ clock: () => now });
    fleet.descriptors = [worker('a-1', 'acme', [digest])];
    await engine.syncAnnouncedSchedules({ graceMs: 1_000 });
    fleet.descriptors = [worker('a-2', 'acme', [])];
    await engine.syncAnnouncedSchedules({ graceMs: 1_000 });
    now += 2_000;
    await engine.syncAnnouncedSchedules({ graceMs: 1_000 });
    fleet.descriptors = [worker('a-3', 'acme', [{ ...digest, everyMs: 30_000 }])];
    await engine.syncAnnouncedSchedules({ graceMs: 1_000 });
    const back = await engine.schedules.get('app:acme:daily');
    expect(back).toMatchObject({ paused: false, everyMs: 30_000 });
    expect(back?.note).toBeUndefined();
  });

  it('withdraws nothing while the app has no live worker, or only workers that do not state schedules', async () => {
    let now = 1_000_000;
    const { engine, fleet } = controlPlane({ clock: () => now });
    fleet.descriptors = [worker('a-1', 'acme', [digest])];
    await engine.syncAnnouncedSchedules({ graceMs: 1 });

    fleet.descriptors = []; // the app is down
    now += 10_000;
    await engine.syncAnnouncedSchedules({ graceMs: 1 });
    // An older SDK (no `schedules` on its descriptor) says nothing about schedules.
    fleet.descriptors = [worker('legacy', 'acme', undefined)];
    now += 10_000;
    await engine.syncAnnouncedSchedules({ graceMs: 1 });
    expect(await engine.schedules.get('app:acme:daily')).toMatchObject({ paused: false });
    expect((await engine.schedules.get('app:acme:daily'))?.unannouncedSince).toBeUndefined();
  });

  it('verifies the announced tenant token when the control plane verifies tenants', async () => {
    const { engine, fleet } = controlPlane({ verifySecret: 's3cret' });
    const good = worker('a-1', 'ignored', [digest]);
    good.schedules = { tenant: await signTenantToken('acme', 's3cret'), items: [digest] };
    const forged = worker('x-1', 'beta', [digest]);
    fleet.descriptors = [good, forged];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await engine.syncAnnouncedSchedules();
    } finally {
      warn.mockRestore();
    }
    expect((await engine.schedules.list()).map((s) => s.id)).toEqual(['app:acme:daily']);
  });

  it('reports a definition that does not evaluate, and never takes over a hand-made schedule', async () => {
    const { engine, fleet } = controlPlane();
    engine.register('digest', '1', async () => 'ok');
    await engine.schedules.create({ id: 'app:acme:mine', workflow: 'digest', every: '1h' });
    fleet.descriptors = [
      worker('a-1', 'acme', [
        { key: 'broken', workflow: 'digest' },
        { key: 'mine', workflow: 'digest', everyMs: 1_000 },
      ]),
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let sync: Awaited<ReturnType<WorkflowEngine['syncAnnouncedSchedules']>>;
    try {
      sync = await engine.syncAnnouncedSchedules();
    } finally {
      warn.mockRestore();
    }
    expect(sync.get('acme')?.invalid.map((i) => i.key)).toEqual(['broken', 'mine']);
    expect((await engine.schedules.get('app:acme:mine'))?.everyMs).toBe(3_600_000);
  });
});

describe('firing an announced schedule', () => {
  it('parks the window as a run waiting for a live worker of the app, instead of failing it', async () => {
    let now = 120_000;
    const { engine, fleet, store } = controlPlane({ clock: () => now });
    fleet.descriptors = [worker('a-1', 'acme', [digest])];
    await engine.syncAnnouncedSchedules();
    fleet.descriptors = []; // the app goes down before the window
    fleet.live = [];

    now = 180_000;
    const started = await engine.schedules.tick(now, { tag: ANNOUNCED_SCHEDULE_TAG });
    expect(started).toEqual(['sched:app:acme:daily:180000']);
    const run = await store.getRun('sched:app:acme:daily:180000');
    expect(run).toMatchObject({ status: 'blocked', namespace: 'acme', workflow: 'digest' });
    expect(run?.error?.code).toBe(NO_LIVE_WORKER);
    expect(run?.tags).toEqual(
      expect.arrayContaining([ANNOUNCED_SCHEDULE_TAG, 'schedule:app:acme:daily']),
    );
    const schedule = await engine.schedules.get('app:acme:daily');
    expect(schedule?.lastError).toBeUndefined();
    expect(schedule?.fires).toBe(1);

    // Later windows while that run still waits fold into it: one waiting run per schedule.
    now = 240_000;
    expect(await engine.schedules.tick(now, { tag: ANNOUNCED_SCHEDULE_TAG })).toEqual([]);
    now = 300_000;
    expect(await engine.schedules.tick(now, { tag: ANNOUNCED_SCHEDULE_TAG })).toEqual([]);
    expect((await store.listRuns({ tags: ['schedule:app:acme:daily'] })).map((r) => r.id)).toEqual([
      'sched:app:acme:daily:180000',
    ]);
  });

  it('starts the window on the live worker of the app when there is one', async () => {
    let now = 120_000;
    const { engine, fleet, store } = controlPlane({ clock: () => now });
    fleet.descriptors = [worker('a-1', 'acme', [digest])];
    fleet.live = ['digest@acme'];
    await engine.syncAnnouncedSchedules();
    now = 180_000;
    await engine.schedules.tick(now, { tag: ANNOUNCED_SCHEDULE_TAG });
    for (let i = 0; i < 100 && fleet.turns.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fleet.turns.map((t) => t.runId)).toEqual(['sched:app:acme:daily:180000']);
    expect((await store.getRun('sched:app:acme:daily:180000'))?.namespace).toBe('acme');
  });

  it('a singleton key the app evaluated is stamped on each fire, namespaced by the app', async () => {
    let now = 120_000;
    const { engine, fleet, store } = controlPlane({ clock: () => now });
    fleet.descriptors = [
      worker('a-1', 'acme', [{ ...digest, singleton: { key: 'digest:ops', limit: 1 } }]),
    ];
    await engine.syncAnnouncedSchedules();
    fleet.descriptors = [];
    now = 180_000;
    await engine.schedules.tick(now, { tag: ANNOUNCED_SCHEDULE_TAG });
    expect((await store.getRun('sched:app:acme:daily:180000'))?.tags).toContain(
      'singleton:acme/digest:ops',
    );
  });

  it('"run now" on an announced schedule waits for a worker too', async () => {
    const { engine, fleet, store } = controlPlane();
    fleet.descriptors = [worker('a-1', 'acme', [digest])];
    await engine.syncAnnouncedSchedules();
    fleet.descriptors = [];
    const { runId, status } = await engine.schedules.trigger('app:acme:daily');
    expect(status).toBe('blocked');
    expect((await store.getRun(runId))?.error?.code).toBe(NO_LIVE_WORKER);
  });

  it('a tag-scoped tick fires only the adopted schedules', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('job', '1', async () => 'ok');
    await engine.schedules.create({ id: 'own', workflow: 'job', every: 1_000 });
    const client = new ScheduleClient(store, {
      start: async () => {
        throw new Error('unexpected start');
      },
      getRun: (id) => store.getRun(id),
    });
    expect(await client.tick(Date.now() + 5_000, { tag: ANNOUNCED_SCHEDULE_TAG })).toEqual([]);
    expect(await client.nextFireAt(Date.now() + 5_000, { tag: ANNOUNCED_SCHEDULE_TAG })).toBe(
      undefined,
    );
  });
});
