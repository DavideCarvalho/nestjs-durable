import {
  type EngineEvent,
  InMemoryStateStore,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProxyRunGateway } from './proxy-run-gateway';
import { RunRequestResponder, type RunRequestTransport } from './run-request-responder';
import { StoreRunGateway } from './store-run-gateway';
import { TenantEventRepublisher } from './tenant-event-republisher';

/**
 * Task 5 — the end-to-end proof of the tenant run gateway: a tenant `ProxyRunGateway` round-trips
 * to an OPERATOR engine over REAL Redis and gets correct, tenant-scoped answers.
 *
 * Wires the operator stack manually (mirrors `durable.module.ts`'s `RunGatewayBootstrap`, without
 * booting Nest): a real store + a real `BullMQTransport` back a `WorkflowEngine`
 * (`namespace: undefined`, drives every tenant), a `StoreRunGateway` answers `RunGateway` calls
 * against it, a `RunRequestResponder` consumes tenant `RunRequest`s off that transport, and a
 * `TenantEventRepublisher` re-publishes the engine's lifecycle events onto each run's per-tenant
 * channel. The tenant side is a SECOND `BullMQTransport` instance on the SAME connection+prefix (not
 * the operator's own instance) — more faithfully simulating a separate tenant process than sharing
 * one instance would — feeding a `ProxyRunGateway` pinned to tenant `davi-local`.
 *
 * No tenant WORKER (`runRedisWorker`) is started: every workflow body here runs in-process on the
 * operator engine (no remote step). That's deliberate — this file proves the GATEWAY round-trip
 * (read/control/stream over the transport), not the drive/dispatch mechanics already covered by
 * `operator-tenant.db.spec.ts` in `transport-bullmq`.
 *
 * Mirrors `bullmq-transport.db.spec.ts`'s real-broker harness: one Redis container (testcontainers),
 * skipped cleanly (never failed) when Docker is unavailable or `SKIP_TESTCONTAINERS` is set. Run
 * with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 180_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;

let redis: StartedRedisContainer | undefined;
let redisError: unknown;
let connection: { host: string; port: number } | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    redis = await new RedisContainer('redis:7-alpine').start();
    connection = { host: redis.getHost(), port: redis.getFirstMappedPort() };
  } catch (err) {
    redisError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await redis?.stop();
});

/** Resolve the live connection or self-skip the case when Docker/Redis isn't available. */
function liveConnection(ctx: { skip: () => void }): { host: string; port: number } {
  if (skipped) {
    ctx.skip();
    throw new Error('unreachable'); // ctx.skip() aborts; keeps the type non-undefined
  }
  if (redisError || !connection) {
    ctx.skip();
    throw new Error('unreachable');
  }
  return connection;
}

/** Poll the store until `runId` reaches a terminal status (mirrors the sibling db.spec's `settle`). */
async function settle(
  store: InMemoryStateStore,
  runId: string,
  timeoutMs = 15_000,
): Promise<WorkflowRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended') {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not settle`);
}

/** Poll the store until `runId` reaches a specific (possibly non-terminal, e.g. `suspended`) status. */
async function waitForStatus(
  store: InMemoryStateStore,
  runId: string,
  status: WorkflowRun['status'],
  timeoutMs = 15_000,
): Promise<WorkflowRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never reached status ${status}`);
}

/** Poll `predicate` until it's true, mirroring `settle()`'s loop shape for non-store round-trips
 *  (e.g. a pub/sub-delivered tenant event landing in a locally-collected array). */
async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition was never met');
}

describe('tenant ProxyRunGateway <-> operator RunGateway (real Redis) [testcontainers]', () => {
  it('reads/cancels/streams tenant-scoped runs over the transport, and denies cross-tenant reads', async (ctx) => {
    const liveConnectionValue = liveConnection(ctx);
    const prefix = `durtest-tenant-rg-${Date.now()}`;

    // --- operator: real store, real BullMQTransport, namespace UNSET (drives every tenant) ---
    const store = new InMemoryStateStore();
    const operatorTransport = new BullMQTransport({ connection: liveConnectionValue, prefix });
    const operatorEngine = new WorkflowEngine({
      store,
      transport: operatorTransport,
      namespace: undefined,
    });
    operatorEngine.register('echo', '1', async (_ctx, input) => input);
    operatorEngine.register('waiter', '1', async (workflowCtx) => {
      await workflowCtx.waitForSignal<void>('release');
      return 'done';
    });

    const gateway = new StoreRunGateway(store, operatorEngine);
    const runRequestTransport: RunRequestTransport = {
      onRunRequest: operatorTransport.onRunRequest.bind(operatorTransport),
      publishRunReply: operatorTransport.publishRunReply.bind(operatorTransport),
    };
    new RunRequestResponder(runRequestTransport, gateway).start();

    const republisher = new TenantEventRepublisher(store, (evt) =>
      operatorTransport.publishTenantEvent(evt),
    );
    const unsubscribeRepublisher = operatorEngine.subscribe((event) => {
      void republisher.handle(event);
    });

    // --- tenant: a SECOND BullMQTransport instance on the SAME connection+prefix (simulates a
    // separate tenant process rather than reusing the operator's own transport instance) ---
    const tenantTransport = new BullMQTransport({ connection: liveConnectionValue, prefix });
    const proxy = new ProxyRunGateway(tenantTransport, 'davi-local');
    // Let onRunReply's pub/sub subscription establish before any request relies on it (mirrors the
    // `await new Promise((r) => setTimeout(r, 200))` convention in `bullmq-transport.db.spec.ts`).
    await new Promise((resolve) => setTimeout(resolve, 250));

    try {
      // --- assertion 1: getRunDetail resolves a run stamped THIS tenant's namespace ---
      await operatorEngine.start('echo', { value: 'hi' }, 'run-davi-1', {
        namespace: 'davi-local',
      });
      await settle(store, 'run-davi-1');

      const detail = await proxy.getRunDetail('run-davi-1');
      expect(detail?.run.id).toBe('run-davi-1');
      expect(detail?.run.namespace).toBe('davi-local');
      expect(detail?.run.status).toBe('completed');
      expect(detail?.run.output).toEqual({ value: 'hi' });
      expect(detail?.children).toEqual([]);

      // --- assertion 2: a run stamped a DIFFERENT namespace is denied (cross-tenant) — the
      // security proof. The responder loads the run and compares `run.namespace` to `msg.tenant`
      // BEFORE returning any data, so a `davi-local` tenant can never read an `other` run. ---
      await operatorEngine.start('echo', { value: 'nope' }, 'run-other-1', {
        namespace: 'other',
      });
      await settle(store, 'run-other-1');

      await expect(proxy.getRunDetail('run-other-1')).rejects.toThrow(
        'run belongs to another tenant',
      );

      // --- assertions 3 & 4: cancel via the proxy actually cancels on the operator, AND the
      // proxy's subscribe sees the resulting run.* event over the tenant's pub/sub channel. ---
      await operatorEngine.start('waiter', {}, 'run-davi-2', { namespace: 'davi-local' });
      await waitForStatus(store, 'run-davi-2', 'suspended');

      const seenEvents: EngineEvent[] = [];
      const unsubscribeProxy = proxy.subscribe('run-davi-2', (event) => {
        seenEvents.push(event);
      });
      // Let onTenantEvent's pub/sub subscription establish before the cancel fires the event.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const cancelResult = await proxy.cancel('run-davi-2');
      expect(cancelResult?.status).toBe('cancelled');

      // Assertion 3, read directly off the OPERATOR store (not the proxy) — the run really did
      // transition, not just the reply the tenant received.
      const cancelledRun = await store.getRun('run-davi-2');
      expect(cancelledRun?.status).toBe('cancelled');

      // Assertion 4 — the tenant channel delivered a run.* event for this run once it settled.
      // Cancellation without `compensate` has no separate `run.cancelled` type; it settles via
      // `run.failed` (see `tenant-event-republisher.ts`'s doc comment) — still a `run.*` event.
      await waitUntil(() => seenEvents.some((event) => event.runId === 'run-davi-2'));
      expect(
        seenEvents.some((event) => event.type === 'run.failed' && event.runId === 'run-davi-2'),
      ).toBe(true);

      unsubscribeProxy();
    } finally {
      unsubscribeRepublisher();
      await tenantTransport.close();
      await operatorTransport.close();
    }
  }, 30_000);
});
