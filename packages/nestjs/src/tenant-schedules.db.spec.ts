import {
  ANNOUNCED_SCHEDULE_TAG,
  DurableWorkflow,
  InMemoryStateStore,
  NO_LIVE_WORKER,
  type ScheduledWorkflow,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { DurableDashboardModule } from '@dudousxd/nestjs-durable-dashboard';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';

/**
 * Schedules declared on a real `DurableModule` TENANT (a `connection`, no `store`), against a
 * `DurableModule` control plane on a real Redis, with the durable dashboard mounted on it:
 *  - the tenant's schedule fires on the control plane and its runs execute on the tenant;
 *  - two replicas announcing the same schedule are one schedule, and one run per window;
 *  - a window that comes due while no tenant worker is live waits, and runs once one boots;
 *  - a schedule the tenant stops declaring is paused (withdrawn) after the grace period;
 *  - pause and resume through the dashboard API.
 *
 * Skipped without Docker (or with `SKIP_TESTCONTAINERS`) unless `DURABLE_TEST_REDIS_URL` is set.
 */

const externalUrl = process.env.DURABLE_TEST_REDIS_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;
let redis: StartedRedisContainer | undefined;
let redisError: unknown;
let connection: { host: string; port: number } | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    if (externalUrl) {
      const u = new URL(externalUrl);
      connection = { host: u.hostname, port: Number(u.port || 6379) };
      return;
    }
    redis = await new RedisContainer('redis:7-alpine').start();
    connection = { host: redis.getHost(), port: redis.getFirstMappedPort() };
  } catch (err) {
    redisError = err;
  }
}, 180_000);

afterAll(async () => {
  await redis?.stop();
});

function live(ctx: { skip: () => void }): { host: string; port: number } {
  if (skipped || redisError || !connection) {
    ctx.skip();
    throw new Error('unreachable');
  }
  return connection;
}

@Workflow({ name: 'report', version: '1' })
class ReportWorkflow extends DurableWorkflow {
  async run(_ctx: WorkflowCtx, input: { n: number }): Promise<{ total: number }> {
    return { total: input.n * 2 };
  }
}

const every = (key: string, everyMs: number): ScheduledWorkflow<typeof ReportWorkflow> => ({
  key,
  workflow: ReportWorkflow,
  input: { n: 21 },
  everyMs,
});

/** The control plane: a `DurableModule` operator with a store, BullMQ, and the dashboard. */
async function controlPlane(conn: { host: string; port: number }, prefix: string) {
  const store = new InMemoryStateStore();
  const transport = new BullMQTransport({ connection: conn, prefix });
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store,
        transport,
        namespace: undefined,
        timerPollMs: 100,
        blockedPollMs: 300,
        announcedSchedules: { syncMs: 200, graceMs: 1_000 },
      }),
      DurableDashboardModule.forRoot(),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return {
    store,
    transport,
    app,
    engine: app.get(WorkflowEngine),
    close: () => app.close(),
  };
}

/** A tenant app serving partition `acme`, declaring `schedules`. */
async function tenantApp(
  conn: { host: string; port: number },
  prefix: string,
  schedules: ScheduledWorkflow[],
  instanceId: string,
): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({ connection: conn, prefix, partition: 'acme', instanceId, schedules }),
    ],
    providers: [ReportWorkflow],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`condition never met; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const runsOf = (store: InMemoryStateStore, scheduleId: string) =>
  store.listRuns({ tag: `schedule:${scheduleId}` });

const completed = (runs: WorkflowRun[]) => runs.filter((r) => r.status === 'completed');

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length > 0)
    await closers
      .pop()?.()
      .catch(() => undefined);
});

describe('schedules declared on a DurableModule tenant (real Redis) [testcontainers]', () => {
  it('fires on the control plane and runs on the tenant; two replicas are one schedule; pause/resume from the dashboard', async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-sched-fire-${Date.now()}`;
    // Two replicas of the same tenant deploy, announcing the same schedule.
    const one = await tenantApp(conn, prefix, [every('tick', 1_000)], 'acme-1');
    closers.push(() => one.close());
    const two = await tenantApp(conn, prefix, [every('tick', 1_000)], 'acme-2');
    closers.push(() => two.close());
    const cp = await controlPlane(conn, prefix);
    closers.push(cp.close);

    const adopted = await until(
      () => cp.engine.schedules.get('app:acme:tick'),
      (s) => s !== null,
      // A busy registry read is cached up to 30 s (#474).
      60_000,
    );
    expect(adopted).toMatchObject({ namespace: 'acme', announcedKey: 'tick', everyMs: 1_000 });
    const record = await cp.store.getSchedule('app:acme:tick');

    // Its windows run on the tenant worker.
    const ran = await until(
      () => runsOf(cp.store, 'app:acme:tick'),
      (runs) => completed(runs).length >= 2,
    );
    expect(completed(ran)[0]).toMatchObject({ namespace: 'acme', output: { total: 42 } });
    expect(completed(ran)[0]?.tags).toContain(ANNOUNCED_SCHEDULE_TAG);

    // Two replicas, many syncs: still one schedule, its definition never rewritten, one run a window.
    expect(await cp.engine.schedules.list({ tag: ANNOUNCED_SCHEDULE_TAG })).toHaveLength(1);
    const now = await cp.store.getSchedule('app:acme:tick');
    expect(now?.spec).toEqual(record?.spec);
    expect(now?.createdAt).toEqual(record?.createdAt);
    const ids = ran.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^sched:app:acme:tick:\d+$/);

    // The dashboard lists it with its app, and pauses / resumes it.
    const server = (cp.app as INestApplication).getHttpServer();
    const listed = await request(server).get('/durable/api/schedules').expect(200);
    expect(listed.body.data).toEqual([
      expect.objectContaining({ id: 'app:acme:tick', namespace: 'acme', announcedKey: 'tick' }),
    ]);
    const paused = await request(server)
      .post('/durable/api/schedules/app%3Aacme%3Atick/pause')
      .expect(201);
    expect(paused.body.paused).toBe(true);
    // Paused: no new window fires (the one in flight may still finish).
    await new Promise((resolve) => setTimeout(resolve, 500));
    const atPause = (await runsOf(cp.store, 'app:acme:tick')).length;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await runsOf(cp.store, 'app:acme:tick')).length).toBe(atPause);
    // The pause survives the tenant's re-announcements.
    expect((await cp.engine.schedules.get('app:acme:tick'))?.paused).toBe(true);

    const resumed = await request(server)
      .post('/durable/api/schedules/app%3Aacme%3Atick/resume')
      .expect(201);
    expect(resumed.body.paused).toBe(false);
    await until(
      () => runsOf(cp.store, 'app:acme:tick'),
      (runs) => completed(runs).length > atPause,
    );
  }, 120_000);

  it('a window that comes due while no tenant worker is live waits, and runs once one boots', async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-sched-offline-${Date.now()}`;
    const first = await tenantApp(conn, prefix, [every('nightly', 3_000)], 'acme-1');
    const cp = await controlPlane(conn, prefix);
    closers.push(cp.close);
    await until(
      () => cp.engine.schedules.get('app:acme:nightly'),
      (s) => s !== null,
      // A busy registry read is cached up to 30 s (#474).
      60_000,
    );

    // The tenant goes down. Once the control plane sees no live worker, the next window waits.
    await first.close();
    await until(
      () => cp.transport.listWorkerGroups(),
      (groups) => !groups.includes('report@acme'),
      150_000,
    );
    const parked = await until(
      () => runsOf(cp.store, 'app:acme:nightly'),
      (runs) => runs.some((r) => r.status === 'blocked'),
      30_000,
    );
    const waiting = parked.find((r) => r.status === 'blocked') as WorkflowRun;
    expect(waiting.error?.code).toBe(NO_LIVE_WORKER);
    // Later windows while it waits are folded into it: one waiting run, however long the outage.
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    const during = await runsOf(cp.store, 'app:acme:nightly');
    expect(during.filter((r) => r.status === 'blocked').map((r) => r.id)).toEqual([waiting.id]);

    // A tenant worker boots: the waiting window runs on it.
    const second = await tenantApp(conn, prefix, [every('nightly', 3_000)], 'acme-2');
    closers.push(() => second.close());
    const done = await until(
      () => cp.store.getRun(waiting.id),
      (run) => run?.status === 'completed',
      60_000,
    );
    expect(done?.output).toEqual({ total: 42 });
  }, 280_000);

  it('a schedule the tenant stops declaring is withdrawn (paused, not deleted)', async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-sched-remove-${Date.now()}`;
    const v1 = await tenantApp(
      conn,
      prefix,
      [every('keep', 60_000), every('drop', 60_000)],
      'acme-v1',
    );
    const cp = await controlPlane(conn, prefix);
    closers.push(cp.close);
    await until(
      () => cp.engine.schedules.list({ tag: ANNOUNCED_SCHEDULE_TAG }),
      (list) => list.length === 2,
      60_000,
    );

    // The next deploy no longer declares `drop`. The control plane keeps counting the old pod's
    // announcement until its registry entries are gone (they expire within about a minute when a
    // reader still holds them), then the grace period runs.
    await v1.close();
    const v2 = await tenantApp(conn, prefix, [every('keep', 60_000)], 'acme-v2');
    closers.push(() => v2.close());
    const withdrawn = await until(
      () => cp.engine.schedules.get('app:acme:drop'),
      (s) => s?.paused === true,
      150_000,
    );
    expect(withdrawn?.withdrawnAt).toBeDefined();
    expect(withdrawn?.note).toMatch(/no longer announces/);
    expect((await cp.engine.schedules.get('app:acme:keep'))?.paused).toBe(false);
  }, 200_000);
});
