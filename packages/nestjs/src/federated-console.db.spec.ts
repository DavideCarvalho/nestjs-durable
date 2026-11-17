import {
  type EngineEvent,
  InMemoryStateStore,
  WorkflowEngine,
  type WorkflowRun,
  hmacTenantVerifier,
  signTenantToken,
} from '@dudousxd/nestjs-durable-core';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { federatedAppGateway } from './federated-app-gateway';
import { RunRequestResponder } from './run-request-responder';
import { StoreRunGateway } from './store-run-gateway';
import { TenantEventRepublisher } from './tenant-event-republisher';

/**
 * The federated console's gateway over BullMQ and a real Redis: two apps, each with its own store
 * and its own prefix on one Redis, wired the way `DurableModule` wires an operator with a broker
 * transport (a run-request responder and a tenant-event republisher on its engine). The console side
 * is a separate `BullMQTransport` on each app's prefix. Every action is executed by the app's engine;
 * app `b` verifies its requesters with an HMAC secret the console signs with.
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

async function until<T>(read: () => Promise<T> | T, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error('condition was never met');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const status = (store: InMemoryStateStore, id: string, want: WorkflowRun['status']) =>
  until(
    () => store.getRun(id),
    (run) => run?.status === want,
  );

/** One app: store, BullMQ transport on its own prefix, engine, responder and event republisher. */
function bootApp(conn: { host: string; port: number }, prefix: string, secret?: string) {
  const store = new InMemoryStateStore();
  const transport = new BullMQTransport({ connection: conn, prefix });
  const engine = new WorkflowEngine({ store, transport, controlPlane: transport });
  engine.register('waiter', '1', async (ctx, input) =>
    ctx.waitForSignal<unknown>((input as { token: string }).token),
  );
  new RunRequestResponder(
    {
      onRunRequest: transport.onRunRequest.bind(transport),
      publishRunReply: transport.publishRunReply.bind(transport),
    },
    new StoreRunGateway(store, engine),
    { verifyTenant: secret ? hmacTenantVerifier(secret) : undefined, warnWithoutVerifier: false },
  ).start();
  const republisher = new TenantEventRepublisher(store, (evt) => transport.publishTenantEvent(evt));
  const off = engine.subscribe((event) => void republisher.handle(event));
  return {
    store,
    engine,
    close: async () => {
      off();
      await transport.close();
    },
  };
}

describe('federated console gateway over BullMQ (real Redis) [testcontainers]', () => {
  it('reads each app from its store and has each app execute its own actions', async (ctx) => {
    if (skipped || redisError || !connection) {
      ctx.skip();
      return;
    }
    const conn = connection;
    const stamp = Date.now();
    const secret = 'b-secret';
    const a = bootApp(conn, `fed-a-${stamp}`);
    const b = bootApp(conn, `fed-b-${stamp}`, secret);
    const consoleA = new BullMQTransport({ connection: conn, prefix: `fed-a-${stamp}` });
    const consoleB = new BullMQTransport({ connection: conn, prefix: `fed-b-${stamp}` });
    const gwA = federatedAppGateway({ store: a.store, transport: consoleA });
    const gwB = federatedAppGateway({
      store: b.store,
      transport: consoleB,
      tenantToken: (namespace) => signTenantToken(namespace, secret),
    });
    // An unsigned console against app b: refused by b's verifier.
    const unsignedTransport = new BullMQTransport({ connection: conn, prefix: `fed-b-${stamp}` });
    const unsignedB = federatedAppGateway({
      store: b.store,
      transport: unsignedTransport,
      timeoutMs: 5_000,
    });

    try {
      await a.engine.start('waiter', { token: 'go:a-1' }, 'a-1');
      await b.engine.start('waiter', { token: 'go:b-1' }, 'b-1');
      await b.engine.start('waiter', { token: 'go:b-2' }, 'b-2');
      await status(a.store, 'a-1', 'suspended');
      await status(b.store, 'b-1', 'suspended');
      await status(b.store, 'b-2', 'suspended');

      // Reads come from each app's own store.
      expect((await gwA.listRuns({})).map((r) => r.id)).toEqual(['a-1']);
      expect((await gwB.listRuns({})).map((r) => r.id).sort()).toEqual(['b-1', 'b-2']);
      expect(await gwB.getRun('a-1')).toBeNull();

      // Live tail of an app run, then a cancel executed by app a's engine.
      const seen: EngineEvent[] = [];
      const off = gwA.subscribe('a-1', (event) => seen.push(event));
      await new Promise((resolve) => setTimeout(resolve, 300)); // let the subscription land
      const cancelled = await gwA.cancel('a-1');
      expect(cancelled?.status).toBe('cancelled');
      expect((await a.store.getRun('a-1'))?.status).toBe('cancelled');
      await until(
        () => seen,
        (events) => events.some((e) => e.runId === 'a-1' && e.type.startsWith('run.')),
      );
      off();

      // App b verifies its requesters: the signed console signals b-1, the unsigned one is refused.
      await expect(unsignedB.cancel('b-2')).rejects.toThrow(/unauthorized|invalid/);
      expect((await b.store.getRun('b-2'))?.status).toBe('suspended');
      await gwB.signal('go:b-1', { ok: true });
      await status(b.store, 'b-1', 'completed');

      // A persisted schedule of app b, triggered by app b.
      await b.engine.schedules.create({
        id: 'nightly',
        workflow: 'waiter',
        input: { token: 'go:nightly' },
        every: '1d',
      });
      expect((await gwB.listSchedules({})).map((s) => s.id)).toEqual(['nightly']);
      const triggered = (await gwB.scheduleAction('nightly', 'trigger')) as { runId: string };
      expect((await b.store.getRun(triggered.runId))?.workflow).toBe('waiter');
      await expect(gwA.scheduleAction('nightly', 'trigger')).rejects.toThrow(/not found/);
    } finally {
      await consoleA.close();
      await consoleB.close();
      await unsignedTransport.close();
      await a.close();
      await b.close();
    }
  }, 60_000);
});
