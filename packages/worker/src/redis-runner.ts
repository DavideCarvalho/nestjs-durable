import { hostname } from 'node:os';
import {
  type StartRunMessage,
  type WorkflowStepEvent,
  tenantGroup,
} from '@dudousxd/nestjs-durable-core';
import { AdaptiveController, type ConcurrencyOption } from './adaptive-concurrency';
import {
  DEFAULT_PREFIX,
  type DurableWorkerRuntime,
  controlChannel,
  decisionsName,
  effectivePrefixOf,
  heartbeatChannel,
  isWorkflowTask,
  resultsName,
  startRunName,
  stepEventsName,
  tasksName,
  workerHeartbeatKey,
} from './runner-core';

// Worker liveness heartbeat: a worker stamps a TTL'd key while it's consuming; the key expiring is
// the "this worker is gone/stalled" signal a monitor watches. TTL comfortably exceeds the interval
// so one slow refresh doesn't flap. Mirrors the Python SDK's `_start_heartbeat` and the TS
// `BullMQTransport.startWorkerHeartbeat`, so a mixed-language group reports all workers under one scan.
const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
const WORKER_HEARTBEAT_TTL_SECONDS = 35;

// Run-scoped liveness heartbeat: while a workflow worker replays a TURN it publishes a beat keyed by
// `runId` (no stepId) on the `<prefix>-heartbeat` channel, so the engine — when configured with
// `remoteAdvanceSilenceMs` — rearms the run's `advance` deadline and never re-drives a worker that's
// alive-but-slow. The engine keys the liveness reset by `runId` when `stepId` is absent.
const RUN_HEARTBEAT_INTERVAL_MS = 5_000;

/** The minimal publish surface a run-scoped heartbeat needs — any ioredis client satisfies it. */
interface HeartbeatPublisher {
  publish(channel: string, payload: string): unknown;
}

/**
 * Start a run-scoped liveness heartbeat for `runId`: publish one beat immediately, then every
 * {@link RUN_HEARTBEAT_INTERVAL_MS} ms, on the `<prefix>-heartbeat` channel as
 * `{ runId, seq: 0, group }` (no `stepId` — the engine keys a run-scoped reset by `runId`). Returns
 * a stop function that clears the interval. Best-effort: a failed/throwing publish is swallowed and
 * never propagates (exactly like the worker-TTL heartbeat). With no client it's a no-op.
 */
export function startRunHeartbeat(
  client: HeartbeatPublisher | undefined,
  prefix: string,
  group: string,
  runId: string,
): () => void {
  if (!client) return () => {};
  const channel = heartbeatChannel(prefix);
  const payload = JSON.stringify({ runId, seq: 0, group });
  const beat = (): void => {
    try {
      // `.publish` may return a promise (ioredis) — swallow a rejection too, never fail the turn.
      void Promise.resolve(client.publish(channel, payload)).catch(() => {});
    } catch {
      /* a synchronous throw must never break or fail the turn */
    }
  };
  beat(); // fire immediately so a just-started turn is visible without waiting a full interval
  const timer = setInterval(beat, RUN_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// A workflow turn can run for minutes (a body of inline `ctx.step` DB calls). Node is single-threaded:
// while `handleTask` is awaited the event loop stays free (the step bodies await), but BullMQ renews
// a job's lock on a timer driven by that same loop. Give the Worker a generous `lockDuration` so a
// long turn never lapses its lock mid-run — which would let BullMQ presume the job dead, REDELIVER it,
// and run the workflow twice. This is the lesson from Track A (the transport-side stall+redeliver).
const DEFAULT_LOCK_DURATION_MS = 5 * 60_000;

/** ioredis `ConnectionOptions` (or an IORedis instance), the same shape `BullMQTransport` accepts. */
// We avoid a static import of ioredis/bullmq types so this file type-checks without those optional
// peers installed; `unknown` is widened at the boundary and the lazy import provides the real ctor.
export type RedisConnection = unknown;

export interface RunRedisWorkerOptions {
  /** The pure routing core: holds the registered workflows + steps. */
  runtime: DurableWorkerRuntime;
  /** The base worker group this instance serves (before any tenant suffix — see {@link tenant}). */
  group: string;
  /** ioredis connection options (or an IORedis instance), as `BullMQTransport` takes. */
  connection: RedisConnection;
  /** Key prefix namespacing the durable queues. Defaults to `durable` (matches the transport). */
  prefix?: string;
  /**
   * The tenant this worker instance serves — DISTINCT from {@link prefix} (the transport prefix
   * stays whatever it is, typically shared with the control plane). Only the worker GROUP it
   * registers/heartbeats under is derived via `tenantGroup(group, tenant)`
   * (`@dudousxd/nestjs-durable-core`): `undefined`, `''`, or `'default'` yields the bare
   * {@link group} (production byte-identical — a single-tenant deployment never sees a suffix);
   * any other tenant yields `<group>@<tenant>`, so an operator control plane's
   * `listWorkerGroups()`/`resolveRemoteByConvention` can route that tenant's runs to this worker.
   */
  tenant?: string;
  /** Stable id for this worker process in heartbeats/control. Defaults to `ts-<hostname>-<pid>`. */
  instanceId?: string;
  /** Override the Worker's job-lock duration (ms). Defaults to 5 min — see {@link DEFAULT_LOCK_DURATION_MS}. */
  lockDuration?: number;
  /**
   * How many tasks this worker runs concurrently from its group's queue (BullMQ Worker concurrency).
   * Defaults to 1. Raise it so a fanned-out batch (e.g. the N remote steps of a `gather`) runs in
   * parallel instead of serially. Per process; total parallelism is `concurrency × replicas`.
   *
   * Pass `'adaptive'` (or `{ mode:'adaptive', min, max, start, ramCeilingPct, cpuCeilingPct, tickMs }`)
   * to let an {@link AdaptiveController} self-tune the limit from a latency gradient, a RAM hard brake
   * and an error/stall backpressure signal. A live status snapshot rides the worker heartbeat in both
   * modes (fixed workers report inFlight/RSS/throughput/p95 too).
   */
  concurrency?: ConcurrencyOption;
  /**
   * Injection seam for tests: supply fake `Worker`/`Queue`/`Redis` ctors instead of lazily importing
   * the real `bullmq`/`ioredis`. Production omits this and the runner imports the real peers.
   */
  deps?: RunnerDeps;
}

/** The bullmq/ioredis surface the runner uses — narrow enough that a test can fake it. */
export interface RunnerDeps {
  Worker: new (
    name: string,
    processor: (job: { data: unknown }) => Promise<unknown>,
    opts: Record<string, unknown>,
  ) => {
    close(): Promise<void>;
    /** BullMQ exposes a settable `concurrency` — the adaptive controller writes it on each adjust. */
    concurrency?: number;
  };
  Queue: new (
    name: string,
    opts: Record<string, unknown>,
  ) => {
    add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
  };
  /** Optional: the pub/sub + heartbeat client ctor. Omit and control/heartbeat are simply off. */
  Redis?: new (
    connection: RedisConnection,
  ) => {
    duplicate(): RedisSubClient;
    set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
    publish(channel: string, payload: string): Promise<unknown>;
    subscribe(channel: string): Promise<unknown>;
    on(event: 'message', listener: (channel: string, payload: string) => void): unknown;
    disconnect(): void;
  };
}

interface RedisSubClient {
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, payload: string) => void): unknown;
  disconnect(): void;
}

/** A running worker handle. `await close()` to drain and stop. */
export interface RunningWorker {
  close(): Promise<void>;
}

/** Lazily import `bullmq` + `ioredis` (optional peers). Mirrors how the transport imports them. */
async function loadDeps(): Promise<RunnerDeps> {
  const bullmq = (await import('bullmq')) as unknown as RunnerDeps;
  const deps: RunnerDeps = { Worker: bullmq.Worker, Queue: bullmq.Queue };
  try {
    const ioredis = (await import('ioredis')) as unknown as { Redis: RunnerDeps['Redis'] };
    // omit when absent so control-channel cancellation + heartbeat are simply off
    if (ioredis.Redis) deps.Redis = ioredis.Redis;
  } catch {
    /* no ioredis present — leave deps.Redis unset */
  }
  return deps;
}

/** BullMQ Workers require `maxRetriesPerRequest: null`; preserve a passed-in instance as-is. */
function workerConnection(connection: RedisConnection): RedisConnection {
  if (
    connection &&
    typeof connection === 'object' &&
    !('options' in (connection as Record<string, unknown>))
  ) {
    return { ...(connection as Record<string, unknown>), maxRetriesPerRequest: null };
  }
  return connection;
}

/**
 * Start a BullMQ worker that consumes `<prefix>-tasks-<group>` and drives the {@link DurableWorkerRuntime}.
 *
 * The queue carries BOTH workflow tasks and remote step tasks (the engine adds them to the same
 * per-group queue): each job is handed to `runtime.handleTask`, which routes by shape and returns
 * either a {@link import('@dudousxd/nestjs-durable-core').WorkflowDecision} — published on
 * `<prefix>-decisions` — or a {@link import('@dudousxd/nestjs-durable-core').StepResult} — published
 * on `<prefix>-results`. A thin Node port of the Python `run_redis_workflow_worker` / `run_redis_worker`,
 * collapsed into one runner because the TS `handleTask` discriminates the two task kinds itself.
 *
 * It also (best-effort): subscribes to `<prefix>-control` and feeds cancellation into the replay's
 * `isCancelled`; streams each local step's lifecycle onto `<prefix>-step-events`; and stamps a TTL'd
 * worker-liveness heartbeat key. None of these can block the worker from starting or processing.
 *
 * `await close()` on the returned handle to drain + stop the worker, queues, and pub/sub.
 */
export async function runRedisWorker(options: RunRedisWorkerOptions): Promise<RunningWorker> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const instanceId = options.instanceId ?? `ts-${hostname()}-${process.pid}`;
  const lockDuration = options.lockDuration ?? DEFAULT_LOCK_DURATION_MS;
  const deps = options.deps ?? (await loadDeps());
  const { runtime, group, connection } = options;
  // The GROUP this instance actually registers/heartbeats under: tenant-suffixed for a real
  // tenant, byte-identical to `group` for undefined/''/'default'. The transport `prefix` above is
  // untouched by `tenant` — only the group name carries it (see `RunRedisWorkerOptions.tenant`).
  const effectiveGroup = tenantGroup(group, options.tenant);

  const queueOpts = { connection };
  const decisions = new deps.Queue(decisionsName(prefix), queueOpts);
  const results = new deps.Queue(resultsName(prefix), queueOpts);
  const stepEvents = new deps.Queue(stepEventsName(prefix), queueOpts);
  const jobOpts = { removeOnComplete: true, removeOnFail: true };

  // Cooperative cancellation: a Set of cancelled runIds fed by the control channel.
  const cancelled = new Set<string>();
  const isCancelled = (runId: string): boolean => cancelled.has(runId);

  // Best-effort step-event streaming: publish each local step's lifecycle live (never fail the turn).
  const onStep = (event: WorkflowStepEvent): void => {
    void stepEvents.add('stepEvent', event, jobOpts).catch(() => {});
  };

  // The concurrency controller: tracks inFlight + a rolling window of completions, snapshots a live
  // status for the heartbeat, and (adaptive mode) re-tunes the live limit. `apply` writes the BullMQ
  // Worker's settable `concurrency`; the Worker is created below with the controller's initial limit.
  // A holder lets `apply` reference the Worker before it's constructed (controller never calls back
  // before `start()`), keeping `worker` a `const`.
  const workerRef: { current?: InstanceType<RunnerDeps['Worker']> } = {};
  const controller = new AdaptiveController({
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    apply: (limit) => {
      if (workerRef.current) workerRef.current.concurrency = limit;
    },
  });

  const processJob = async (job: { data: unknown }): Promise<void> => {
    const task = job.data as Parameters<DurableWorkerRuntime['handleTask']>[0];
    // While replaying a WORKFLOW turn, beat run-scoped liveness so the engine's heartbeat-rearmed
    // `advance` deadline never re-drives a worker that's alive-but-slow. Only workflow tasks carry a
    // run the engine awaits an `advance` for; a remote-step task is not beaten (harmless either way).
    const stopBeat =
      isWorkflowTask(task) && heartbeatClient
        ? startRunHeartbeat(heartbeatClient, prefix, effectiveGroup, task.runId)
        : () => {};
    const startedAt = Date.now();
    controller.onStart();
    let ok = false;
    try {
      // `handleTask` is async; awaiting it keeps the event loop free (step bodies await), so the job
      // lock can renew and the worker's heartbeat keeps stamping — no stall, no redeliver.
      const out = await runtime.handleTask(task, { onStep, isCancelled });
      if (out.kind === 'decision') {
        await decisions.add('decision', out.decision, jobOpts);
      } else {
        await results.add('result', out.result, jobOpts);
      }
      ok = true;
    } finally {
      // One pool, two task kinds. Only step completions feed the adaptive measurement window; a
      // workflow turn's duration would corrupt the latency gradient (it suspends, it doesn't block).
      controller.onSettle(Date.now() - startedAt, ok, isWorkflowTask(task) ? 'workflow' : 'step');
      // Stop the run-scoped beat the moment the turn settles (success OR failure).
      stopBeat();
    }
  };

  const worker = new deps.Worker(tasksName(prefix, effectiveGroup), processJob, {
    connection: workerConnection(connection),
    lockDuration,
    concurrency: controller.initialLimit,
  });
  workerRef.current = worker;
  // Run the control loop (a no-op-on-limit timer for a fixed worker, an AIMD loop for an adaptive one).
  controller.start();

  // --- best-effort pub/sub control channel + worker-liveness heartbeat (mirror the Python SDK) ---
  let controlSub: RedisSubClient | undefined;
  let heartbeatClient: InstanceType<NonNullable<RunnerDeps['Redis']>> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  if (deps.Redis) {
    try {
      const base = new deps.Redis(connection);
      // Subscribe blocks the client, so use a dedicated (duplicated) connection for it.
      controlSub = base.duplicate();
      void controlSub.subscribe(controlChannel(prefix));
      controlSub.on('message', (_channel, payload) => {
        try {
          const msg = JSON.parse(payload) as { kind?: string; runId?: string };
          if (msg.kind === 'cancel' && typeof msg.runId === 'string') cancelled.add(msg.runId);
        } catch {
          /* ignore malformed control messages */
        }
      });

      heartbeatClient = base;
      const key = workerHeartbeatKey(prefix, effectiveGroup, instanceId);
      const beat = () => {
        // The heartbeat value is now `{ts,status}` JSON (was a bare ms timestamp) — readers accept
        // both. The status is the controller's live snapshot, refreshed cheaply on every beat.
        const value = JSON.stringify({ ts: Date.now(), status: controller.snapshot() });
        void heartbeatClient?.set(key, value, 'EX', WORKER_HEARTBEAT_TTL_SECONDS).catch(() => {});
      };
      beat(); // fire immediately so a fresh worker is visible without waiting a full interval
      heartbeatTimer = setInterval(beat, WORKER_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
    } catch {
      // control channel + heartbeat are best-effort: a failure here must never break startup.
      controlSub = undefined;
      heartbeatClient = undefined;
    }
  }

  return {
    async close(): Promise<void> {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      controller.stop();
      await worker.close();
      await Promise.all([decisions.close(), results.close(), stepEvents.close()]);
      controlSub?.disconnect();
      heartbeatClient?.disconnect();
    },
  };
}

// ---------------------------------------------------------------------------
// P4.3 — startRun: tenant worker → control plane (DB-less run dispatch)
// ---------------------------------------------------------------------------

/** The minimal BullMQ Queue surface `startRun` needs — narrow enough for a test fake. */
export interface StartRunDeps {
  Queue: new (
    name: string,
    opts: Record<string, unknown>,
  ) => {
    add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
  };
}

export interface StartRunOptions {
  /** Tenant (namespace) that owns the run — stamped as {@link StartRunMessage.tenant}. */
  tenant: string;
  /** Registered workflow name. */
  workflow: string;
  /** Workflow input payload (any JSON-serialisable value). */
  input: StartRunMessage['input'];
  /**
   * Optional caller-supplied run id (idempotency key) — passed through onto {@link StartRunMessage}
   * VERBATIM, exactly as given. `startRun` never mints a fresh id in its place: this call sits at
   * the head of a retryable, at-least-once BullMQ path (queue add → consumer → engine), so
   * substituting a uuid here (e.g. per delivery) would make a REDELIVERED `startRun` create a
   * second run instead of being deduplicated against the first. If `runId` is omitted, the control
   * plane's `onStartRun` consumer mints one itself, and a redelivery of THAT specific call is not
   * idempotent — callers that need idempotent redelivery must always supply their own `runId`.
   */
  runId?: string | undefined;
  /** Tags merged into the run at creation. */
  tags?: string[] | undefined;
  /** Queue key prefix. Defaults to `'durable'` (matches `BullMQTransport` default). */
  prefix?: string | undefined;
  /**
   * Logical deployment namespace, folded into `prefix` by the cross-SDK rule
   * (`effectivePrefixOf`). Omit or `'default'` keeps names byte-identical to the bare scheme.
   */
  namespace?: string | undefined;
  /** Injection seam for tests: supply a fake Queue ctor instead of importing bullmq. */
  deps?: StartRunDeps | undefined;
}

/** Lazily import bullmq's Queue (optional peer). */
async function loadStartRunDeps(): Promise<StartRunDeps> {
  // bullmq's module type doesn't structurally overlap the narrow ctor we need, so go via
  // `unknown` — the same idiom the sibling `loadRunnerDeps` uses for this optional-peer import.
  const { Queue } = (await import('bullmq')) as unknown as {
    Queue: StartRunDeps['Queue'];
  };
  return { Queue };
}

/**
 * Publish a {@link StartRunMessage} onto `<effectivePrefix>-start-run`, requesting the control
 * plane to start a new run. This is the **DB-less tenant-worker path** (P4): a worker that has no
 * direct access to the orchestrator's DB dispatches here; the control plane's `onStartRun`
 * consumer turns the message into a durable run.
 *
 * One-shot: opens a Queue, adds the job, then closes the Queue. For high-frequency callers,
 * prefer holding a `BullMQTransport` and calling `transport.dispatchStartRun` directly.
 */
export async function startRun(connection: RedisConnection, opts: StartRunOptions): Promise<void> {
  const effectivePrefix = effectivePrefixOf(opts.prefix ?? DEFAULT_PREFIX, opts.namespace);
  const queueName = startRunName(effectivePrefix);
  const { Queue } = opts.deps ?? (await loadStartRunDeps());
  const queue = new Queue(queueName, { connection });
  const msg: StartRunMessage = {
    tenant: opts.tenant,
    workflow: opts.workflow,
    input: opts.input,
  };
  if (opts.runId !== undefined) msg.runId = opts.runId;
  if (opts.tags !== undefined) msg.tags = opts.tags;
  try {
    await queue.add('startRun', msg, { removeOnComplete: true, removeOnFail: true });
  } finally {
    await queue.close();
  }
}
