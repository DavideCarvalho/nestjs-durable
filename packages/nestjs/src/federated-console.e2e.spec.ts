import 'reflect-metadata';
import {
  InMemoryStateStore,
  InMemoryTransport,
  type RunReply,
  type RunRequest,
  type TenantEvent,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { DurableDashboardModule } from '@dudousxd/nestjs-durable-dashboard';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
import { federatedAppGateway } from './federated-app-gateway';

/**
 * The federated console end to end: two apps, each with its OWN store and its own broker, and one
 * console (a "hub" app with a store of its own) that shows all three. Reads come from each app's
 * store; every action goes to the app over its broker as a run request, and the app's own engine
 * executes it. The hub's engine never touches another app's run.
 *
 * Each app's broker is an in-process one carrying the run-request protocol (a JSON round trip per
 * message, as over Redis), so the spec runs without Docker; `federated-console.db.spec.ts` runs the
 * same round trip over BullMQ and a real Redis.
 */

/** An in-process broker for ONE app: tasks and control as `InMemoryTransport`, plus run requests. */
class AppBroker extends InMemoryTransport {
  readonly requests: RunRequest[] = [];
  private requestHandler: ((msg: RunRequest) => Promise<void>) | undefined;
  private readonly replyHandlers = new Set<(reply: RunReply) => void>();
  private readonly eventHandlers = new Set<{ tenant: string; fn: (e: TenantEvent) => void }>();

  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    const wire = JSON.parse(JSON.stringify(msg)) as RunRequest;
    this.requests.push(wire);
    setImmediate(() => void this.requestHandler?.(wire));
  }

  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.requestHandler = handler;
  }

  async publishRunReply(reply: RunReply): Promise<void> {
    const wire = JSON.parse(JSON.stringify(reply)) as RunReply;
    for (const handler of this.replyHandlers) handler(wire);
  }

  onRunReply(handler: (reply: RunReply) => void): void {
    this.replyHandlers.add(handler);
  }

  async publishTenantEvent(evt: TenantEvent): Promise<void> {
    const wire = JSON.parse(JSON.stringify(evt)) as TenantEvent;
    for (const h of this.eventHandlers) if (h.tenant === wire.tenant) h.fn(wire);
  }

  onTenantEvent(tenant: string, fn: (evt: TenantEvent) => void): () => void {
    const entry = { tenant, fn };
    this.eventHandlers.add(entry);
    return () => this.eventHandlers.delete(entry);
  }
}

@Workflow({ name: 'wait.go', version: '1' })
class WaitForGo {
  async run(ctx: WorkflowCtx, input: { token: string }) {
    return ctx.waitForSignal<{ ok: boolean }>(input.token);
  }
}

const apps: INestApplication[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** One app: its own store and broker, its own engine driving its runs. */
async function bootApp() {
  const store = new InMemoryStateStore();
  const broker = new AppBroker();
  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ store, transport: broker, timerPollMs: 20 })],
    providers: [WaitForGo],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  apps.push(app);
  return { store, broker, engine: app.get(WorkflowEngine) };
}

type App = Awaited<ReturnType<typeof bootApp>>;

/**
 * The hub: its own durable app plus the console, federating `a` and `b`. `x-viewer: only-a` is a
 * viewer granted app `a` alone.
 */
async function bootHub(a: App, b: App) {
  const store = new InMemoryStateStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 20 }),
      DurableDashboardModule.forRoot({
        authorize: (ctx: ExecutionContext) => {
          const viewer = ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>()
            .headers['x-viewer'];
          return viewer === 'only-a' ? { allowed: true, apps: ['a'] } : true;
        },
        federation: {
          localLabel: 'Hub',
          apps: [
            {
              name: 'a',
              label: 'Orders',
              gateway: federatedAppGateway({ store: a.store, transport: a.broker }),
            },
            { name: 'b', gateway: federatedAppGateway({ store: b.store, transport: b.broker }) },
          ],
        },
      }),
    ],
    providers: [WaitForGo],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  apps.push(app);
  return { server: app.getHttpServer(), store, engine: app.get(WorkflowEngine) };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function suspended(store: InMemoryStateStore, id: string): Promise<void> {
  const run = await until(
    () => store.getRun(id),
    (r) => r?.status === 'suspended',
  );
  expect(run?.status).toBe('suspended');
}

const ids = (body: { data: Array<{ id: string }> }) => body.data.map((r) => r.id).sort();

async function bootAll() {
  const a = await bootApp();
  const b = await bootApp();
  const hub = await bootHub(a, b);
  await a.engine.start('wait.go', { token: 'go:a-1' }, 'a-1');
  await b.engine.start('wait.go', { token: 'go:b-1' }, 'b-1');
  await hub.engine.start('wait.go', { token: 'go:h-1' }, 'h-1');
  await suspended(a.store, 'a-1');
  await suspended(b.store, 'b-1');
  await suspended(hub.store, 'h-1');
  return { a, b, hub };
}

describe('federated console', () => {
  it('[federated-reads] lists each app from its own store, selected by header or ?app=', async () => {
    const { hub } = await bootAll();

    const own = await request(hub.server).get('/durable/api/runs').expect(200);
    expect(ids(own.body)).toEqual(['h-1']);

    const a = await request(hub.server)
      .get('/durable/api/runs')
      .set('x-durable-app', 'a')
      .expect(200);
    expect(ids(a.body)).toEqual(['a-1']);
    expect(a.body.meta.total).toBe(1);

    const b = await request(hub.server).get('/durable/api/runs').set('x-durable-app', 'b');
    expect(ids(b.body)).toEqual(['b-1']);

    // The detail of one app's run is not found through another app.
    await request(hub.server).get('/durable/api/runs/a-1').set('x-durable-app', 'b').expect(404);
    const detail = await request(hub.server)
      .get('/durable/api/runs/a-1')
      .set('x-durable-app', 'a')
      .expect(200);
    expect(detail.body.run.id).toBe('a-1');

    // An app the console does not federate is a 404, not the console's own runs.
    await request(hub.server).get('/durable/api/runs').set('x-durable-app', 'zzz').expect(404);
  });

  it('[federated-topology] tells the SPA which apps the viewer may switch to', async () => {
    const { hub } = await bootAll();
    const all = await request(hub.server).get('/durable/api/topology').expect(200);
    expect(all.body.federation).toEqual({
      local: { label: 'Hub' },
      apps: [
        { name: 'a', label: 'Orders' },
        { name: 'b', label: 'b' },
      ],
    });
    const onA = await request(hub.server)
      .get('/durable/api/topology')
      .set('x-durable-app', 'a')
      .expect(200);
    expect(onA.body.federation.current).toBe('a');

    const onlyA = await request(hub.server)
      .get('/durable/api/topology')
      .set('x-viewer', 'only-a')
      .expect(200);
    expect(onlyA.body.federation.apps).toEqual([{ name: 'a', label: 'Orders' }]);
  });

  it('[federated-grant] a viewer granted app a cannot select app b', async () => {
    const { hub } = await bootAll();
    const a = await request(hub.server)
      .get('/durable/api/runs')
      .set('x-viewer', 'only-a')
      .set('x-durable-app', 'a')
      .expect(200);
    // The grant admits the whole app: its runs are not narrowed to a namespace named `a`.
    expect(ids(a.body)).toEqual(['a-1']);
    await request(hub.server)
      .get('/durable/api/runs')
      .set('x-viewer', 'only-a')
      .set('x-durable-app', 'b')
      .expect(404);
    await request(hub.server)
      .post('/durable/api/runs/b-1/cancel')
      .set('x-viewer', 'only-a')
      .set('x-durable-app', 'b')
      .expect(404);
  });

  it('[federated-actions] a cancel is executed by the app that owns the run, over its broker', async () => {
    const { a, b, hub } = await bootAll();

    // The console's live tail of the app run listens on the app's control channel.
    const live: string[] = [];
    const tail = federatedAppGateway({ store: a.store, transport: a.broker }).subscribe(
      'a-1',
      (event) => live.push(event.type),
    );

    await request(hub.server)
      .post('/durable/api/runs/a-1/cancel')
      .set('x-durable-app', 'a')
      .expect(201);

    const cancelled = await until(
      () => a.store.getRun('a-1'),
      (run) => run?.status === 'cancelled',
    );
    expect(cancelled?.status).toBe('cancelled');
    await until(
      async () => live,
      (types) => types.some((t) => t.startsWith('run.')),
    );
    expect(live.some((t) => t.startsWith('run.'))).toBe(true);
    tail();
    expect(a.broker.requests.map((r) => [r.tenant, r.body.kind])).toEqual([['default', 'cancel']]);
    // Nothing reached the other app, and the hub's own store never learnt of the run.
    expect(b.broker.requests).toEqual([]);
    expect(await hub.store.getRun('a-1')).toBeNull();
    expect((await b.store.getRun('b-1'))?.status).toBe('suspended');

    // A run id of app a, asked of app b, is not found and sends nothing.
    await request(hub.server).post('/durable/api/runs/a-1/retry').set('x-durable-app', 'b');
    expect(b.broker.requests).toEqual([]);
  });

  it('[federated-signal] a signal reaches the app run waiting on the token, delivered by that app', async () => {
    const { b } = await bootAll();
    const gateway = federatedAppGateway({ store: b.store, transport: b.broker });

    expect(await gateway.signal('go:nobody', { ok: true })).toBeNull();
    expect(b.broker.requests).toEqual([]); // no waiter: nothing sent, nothing buffered

    await gateway.signal('go:b-1', { ok: true });
    const done = await until(
      () => b.store.getRun('b-1'),
      (run) => run?.status === 'completed',
    );
    expect(done?.status).toBe('completed');
    expect(b.broker.requests.map((r) => r.body.kind)).toEqual(['signal']);
  });

  it('[federated-schedules] lists an app schedule and triggers it in that app', async () => {
    const { a, hub } = await bootAll();
    await a.engine.schedules.create({
      id: 'nightly',
      workflow: 'wait.go',
      input: { token: 'go:nightly' },
      every: '1d',
    });

    const listed = await request(hub.server)
      .get('/durable/api/schedules')
      .set('x-durable-app', 'a')
      .expect(200);
    expect(listed.body.data.map((s: { id: string }) => s.id)).toEqual(['nightly']);
    const own = await request(hub.server).get('/durable/api/schedules').expect(200);
    expect(own.body.data).toEqual([]);

    // Not app b's schedule.
    await request(hub.server)
      .post('/durable/api/schedules/nightly/trigger')
      .set('x-durable-app', 'b')
      .expect(404);

    const triggered = await request(hub.server)
      .post('/durable/api/schedules/nightly/trigger')
      .set('x-durable-app', 'a')
      .expect(201);
    const runId = triggered.body.runId as string;
    expect(runId).toBeTruthy();
    expect((await a.store.getRun(runId))?.workflow).toBe('wait.go');
    expect(await hub.store.getRun(runId)).toBeNull();
  });

  it('[federated-501] operations of the console engine are refused for a federated app', async () => {
    const { hub } = await bootAll();
    await request(hub.server)
      .get('/durable/api/runs/a-1/events/k')
      .set('x-durable-app', 'a')
      .expect(501);
    await request(hub.server).get('/durable/api/metrics').set('x-durable-app', 'a').expect(501);
  });
});
