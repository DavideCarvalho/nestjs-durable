import { DurableWorkerRuntime, type RunningWorker, runRedisWorker } from '@dudousxd/durable-worker';
import {
  InMemoryStateStore,
  WorkflowEngine,
  type WorkflowRun,
  tenantGroup,
} from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * P4C.5 — the cross-package composition the whole "hosted control plane" increment (P4) exists
 * for: an OPERATOR (`namespace: undefined`, convention dispatch — always on) drives a TENANT's run
 * over a SHARED BullMQ prefix, routing purely by the tenant-suffixed group `tenantGroup(workflow, tenant)`
 * (`w@t1`) — never by a per-tenant queue prefix. Every surface here is real (a real
 * `BullMQTransport` on the operator side, a real `runRedisWorker` on the tenant side, real Redis),
 * unlike `operator-drive-mode.spec.ts` / `control-plane-drive.spec.ts` (core/nestjs), which prove
 * the same routing decisions against FAKE transports. This is the one place that proves the wire
 * round-trip (dispatch → tenant execution → decision → completion) actually works end-to-end.
 *
 * Mirrors `bullmq-transport.db.spec.ts`'s real-broker harness: one Redis container (testcontainers),
 * skipped cleanly (never failed) when Docker is unavailable or `SKIP_TESTCONTAINERS` is set. Run
 * with `pnpm test:db`.
 *
 * The run is seeded directly into the operator's store with `namespace: 't1'` rather than routed
 * through the `startRun()` → `onStartRun` wire helper (both exercised, without a live broker, in
 * `start-run-protocol.spec.ts` / `start-run.spec.ts` / `tenant-worker.spec.ts`): this file's job is
 * the DRIVE path — `runPending`/`recoverIncomplete` discovering + dispatching + recovering a run
 * that "arrived" from elsewhere, exactly the scenario `control-plane-drive.spec.ts` documents as
 * "a run enqueued elsewhere (e.g. a tenant worker's DB-less startRun)".
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

/** Poll until `group` shows up in the operator's live-worker discovery (its heartbeat has landed). */
async function waitForLiveGroup(
  transport: BullMQTransport,
  group: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const groups = await transport.listWorkerGroups();
    if (groups.includes(group)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`worker group ${group} never went live`);
}

describe('operator ↔ tenant e2e (real Redis) [testcontainers]', () => {
  it("an operator drives a tenant worker's run over a shared prefix, routing by w@t1, then recovers an orphaned run the same way", async (ctx) => {
    const liveConnectionValue = liveConnection(ctx);
    const prefix = `durtest-optenant-${Date.now()}`;
    const workflow = 'w';
    const tenant = 't1';
    const group = tenantGroup(workflow, tenant); // 'w@t1'

    // --- tenant worker: registers ONLY the tenant-suffixed group, on the SAME shared prefix ---
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow(workflow, async () => ({ handledBy: 'tenant-worker', tenant }));
    const tenantWorker: RunningWorker = await runRedisWorker({
      runtime,
      connection: liveConnectionValue,
      prefix,
      // Pre-existing rot, unrelated to tenant step routing: this called the long-removed
      // `{ group, tenant }` option shape, which `runRedisWorker` ignored — so the worker came up on
      // the BARE `w` token and `w@t1` never went live. The axis is `partition`.
      partition: tenant,
    });

    // --- operator: namespace UNSET (drives every tenant), on the bare/shared prefix ---
    const store = new InMemoryStateStore();
    const operatorTransport = new BullMQTransport({ connection: liveConnectionValue, prefix });
    const operator = new WorkflowEngine({
      store,
      transport: operatorTransport,
      namespace: undefined,
    });

    try {
      // The tenant worker's heartbeat must be visible to the operator's `listWorkerGroups()` BEFORE
      // any dispatch, or convention routing has nothing live to resolve `w@t1` against.
      await waitForLiveGroup(operatorTransport, group);

      // --- a run "arrives" already stamped with the tenant's namespace (the onStartRun-created
      // shape — see `start-run-protocol.spec.ts` for that stamping unit-tested without a broker) ---
      const created = new Date();
      await store.createRun({
        id: 'run-t1-1',
        workflow,
        workflowVersion: '1',
        status: 'pending',
        input: { orderId: 'o1' },
        namespace: tenant,
        createdAt: created,
        updatedAt: created,
      });

      // DRIVE PATH #1 — the poll loop discovers the pending run and routes it to the LIVE
      // tenant-suffixed group (never a bare 'w' — no bare worker is running).
      await operator.runPending();

      const completed = await settle(store, 'run-t1-1');
      expect(completed.status).toBe('completed');
      expect(completed.namespace).toBe(tenant);
      expect(completed.output).toEqual({ handledBy: 'tenant-worker', tenant });

      // DRIVE PATH #2 — recovery: an orphaned (crashed-worker) run in the SAME tenant is reclaimed
      // and re-dispatched to the SAME live group, without ever being scoped to a single namespace
      // (an operator recovers every namespace, not just its own).
      const orphaned = new Date();
      await store.createRun({
        id: 'run-t1-2',
        workflow,
        workflowVersion: '1',
        status: 'running',
        input: { orderId: 'o2' },
        namespace: tenant,
        createdAt: orphaned,
        updatedAt: orphaned,
      });

      await operator.recoverIncomplete();

      const recovered = await settle(store, 'run-t1-2');
      expect(recovered.status).toBe('completed');
      expect(recovered.namespace).toBe(tenant);
      expect(recovered.output).toEqual({ handledBy: 'tenant-worker', tenant });
    } finally {
      await tenantWorker.close();
      await operatorTransport.close();
    }
  }, 30_000);

  // Regression: the case above routes by CONVENTION (nothing registered locally). This one covers the
  // hybrid that broke — the operator has the workflow registered LOCALLY (an app that registers every
  // @Workflow app-wide, so its API pods can start runs), so it executes the body in-process. Its
  // dispatched STEP used to fall back to the BARE token and get executed by whatever pool shares the
  // broker — the deployed cluster — instead of the tenant's own workers.
  it("a locally-registered body executed in-process still dispatches its step to the TENANT's pool", async (ctx) => {
    const liveConnectionValue = liveConnection(ctx);
    const prefix = `durtest-hybrid-${Date.now()}`;
    const workflow = 'pipeline';
    const step = 'IngestionRead.run';
    const tenant = 'jordi-local';
    const executedBy: string[] = [];

    // --- the tenant's own worker: serves `<step>@jordi-local` ---
    const tenantRuntime = new DurableWorkerRuntime({ workflowGroup: tenant });
    tenantRuntime.registerStep(step, async () => {
      executedBy.push('tenant');
      return { from: 'tenant' };
    });
    const tenantWorker: RunningWorker = await runRedisWorker({
      runtime: tenantRuntime,
      connection: liveConnectionValue,
      prefix,
      partition: tenant,
      instanceId: 'ts-tenant-laptop',
    });

    // --- the deployed cluster's worker: serves the BARE token on the SAME broker ---
    const clusterRuntime = new DurableWorkerRuntime();
    clusterRuntime.registerStep(step, async () => {
      executedBy.push('cluster');
      return { from: 'cluster' };
    });
    const clusterWorker: RunningWorker = await runRedisWorker({
      runtime: clusterRuntime,
      connection: liveConnectionValue,
      prefix,
      instanceId: 'ts-cluster-pod',
    });

    // --- the global operator, WITH the workflow registered locally ---
    const store = new InMemoryStateStore();
    const operatorTransport = new BullMQTransport({ connection: liveConnectionValue, prefix });
    const operator = new WorkflowEngine({ store, transport: operatorTransport });
    let ranInProcess = false;
    operator.register(workflow, '1', async (c) => {
      ranInProcess = true;
      return await c.step(step, { file: 'tenant-upload.mp4' });
    });

    try {
      await waitForLiveGroup(operatorTransport, tenantGroup(step, tenant));
      await waitForLiveGroup(operatorTransport, step);

      await operator.start(workflow, {}, 'run-hybrid-1', { namespace: tenant });
      const run = await settle(store, 'run-hybrid-1');

      expect(run.status).toBe('completed');
      expect(ranInProcess).toBe(true); // the body DID run on the operator (unchanged by design)
      expect(executedBy).toEqual(['tenant']); // ...but its step ran on the tenant's pool, not the cluster's
    } finally {
      await tenantWorker.close();
      await clusterWorker.close();
      await operatorTransport.close();
    }
  }, 30_000);
});
