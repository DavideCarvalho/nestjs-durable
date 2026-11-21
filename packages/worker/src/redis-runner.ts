import { hostname } from 'node:os';
import {
  type ScheduleAnnouncement,
  type SearchAttributes,
  type StartRunMessage,
  type WorkerDescriptor,
  type WorkflowRegistration,
  type WorkflowStepEvent,
  describeWorker,
  descriptorHash,
  sanitizeQueueToken,
  tenantGroup,
} from '@dudousxd/nestjs-durable-core';
import { AdaptiveController, type ConcurrencyOption } from './adaptive-concurrency';
import { normalizeRedisConnection } from './redis-url';
import { ResultPublisher } from './result-publisher';
import {
  DEFAULT_PREFIX,
  type DurableWorkerRuntime,
  controlChannel,
  decisionsName,
  effectivePrefixOf,
  heartbeatChannel,
  isWorkflowTask,
  startRunName,
  stepEventsName,
  tasksName,
  workerDescriptorKey,
  workerHeartbeatKey,
} from './runner-core';
import { RegistryWriter, type WorkerRegistryWriteOptions } from './worker-registry';

/** How long `close()` waits for this worker's registry entries to be removed. */
const REGISTRY_REMOVE_WAIT_MS = 1_000;

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

/** A positive finite millisecond value, or `undefined` for anything else (unset, 0, NaN, negative). */
function positiveMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** ioredis `ConnectionOptions` (or an IORedis instance), the same shape `BullMQTransport` accepts. */
// We avoid a static import of ioredis/bullmq types so this file type-checks without those optional
// peers installed; `unknown` is widened at the boundary and the lazy import provides the real ctor.
export type RedisConnection = unknown;

export interface RunRedisWorkerOptions {
  /** The pure routing core: holds the registered workflows + steps — ALSO the subscription surface:
   *  the runner starts one BullMQ `Worker` per name in `runtime.registeredNames()` (workflows ∪
   *  steps), not a single hand-declared group queue. */
  runtime: DurableWorkerRuntime;
  /** ioredis connection options (or an IORedis instance), as `BullMQTransport` takes. */
  connection: RedisConnection;
  /** Key prefix namespacing the durable queues. Defaults to `durable` (matches the transport). */
  prefix?: string;
  /**
   * The isolation partition this worker instance serves — DISTINCT from {@link prefix} (the
   * transport prefix stays whatever it is, typically shared with the control plane). Each
   * per-handler queue token is derived via `tenantGroup(sanitizeQueueToken(name), partition)`
   * (`@dudousxd/nestjs-durable-core`): `undefined`, `''`, or `'default'` yields the bare sanitized
   * `name` (production byte-identical — a single-tenant deployment never sees a suffix); any other
   * partition yields `<name>@<partition>`, so an operator control plane's
   * `listWorkerGroups()`/`resolveRemoteByConvention` can route that tenant's runs to this worker.
   */
  partition?: string;
  /** Stable id for this worker process in heartbeats/control. Defaults to `ts-<hostname>-<pid>`. */
  instanceId?: string;
  /**
   * The worker registry this worker advertises into: its field of `<prefix>-workers:instances` (one
   * `HSET` per beat, the layout the BullMQ transport and the AdonisJS lib read), plus the
   * per-instance keys older readers read while `legacyWrites` is on (default; refreshed every
   * `legacyWriteIntervalMs`, 30 s). Turn `legacyWrites` off once every reader runs a version that
   * reads the hash.
   */
  workerRegistry?: WorkerRegistryWriteOptions;
  /**
   * Override the Worker's job-lock duration (ms, BullMQ `lockDuration`). Defaults to 5 min — see
   * {@link DEFAULT_LOCK_DURATION_MS}. It is also how long a task held by a worker that died waits
   * before BullMQ can redeliver it, so a shorter lock recovers a crashed worker's task sooner; keep
   * it well above the longest event-loop stall a healthy turn can cause, or a live turn is redelivered.
   * Ignored unless a positive finite number.
   */
  lockDuration?: number;
  /**
   * How often (ms) each Worker checks its queue for stalled jobs (BullMQ `stalledInterval`). Omitted:
   * BullMQ's own default (30 s). Ignored unless a positive finite number.
   */
  stalledInterval?: number;
  /**
   * How many times a job may stall before BullMQ fails it for good (BullMQ `maxStalledCount`).
   * Omitted: BullMQ's own default (1). Ignored unless a non-negative integer.
   */
  maxStalledCount?: number;
  /**
   * How many tasks this worker runs concurrently PER SUBSCRIBED QUEUE (BullMQ Worker concurrency —
   * the same limit is applied to every per-name `Worker` this runner starts, except the names
   * {@link concurrencyByHandler} overrides). Defaults to 1. Raise
   * it so a fanned-out batch (e.g. the N remote steps of a `gather`) runs in parallel instead of
   * serially. Per process; total parallelism is `concurrency × distinct names × replicas`.
   *
   * Pass `'adaptive'` (or `{ mode:'adaptive', min, max, start, ramCeilingPct, cpuCeilingPct, tickMs }`)
   * to let an {@link AdaptiveController} self-tune the limit from a latency gradient, a RAM hard brake
   * and an error/stall backpressure signal. A live status snapshot rides the worker heartbeat in both
   * modes (fixed workers report inFlight/RSS/throughput/p95 too).
   */
  concurrency?: ConcurrencyOption;
  /**
   * Per-name concurrency overrides, keyed by the exact registered workflow or step NAME (as passed
   * to `registerWorkflow`/`registerStep`, namespace included, before queue-token sanitizing). The
   * Worker for a named queue runs at this limit instead of {@link concurrency}; every other queue
   * keeps {@link concurrency}. An overridden name gets its own {@link AdaptiveController}, so an
   * adaptive override tunes that queue alone, and each queue's heartbeat reports the status of the
   * controller that governs it. A name that is not registered on `runtime` is ignored, with one
   * warning per name per process.
   */
  concurrencyByHandler?: Record<string, ConcurrencyOption>;
  /**
   * The recurring starts this worker's app declares, announced on its descriptor so the control
   * plane adopts them as persisted schedules and fires them (see `ScheduleAnnouncement`). `tenant` is
   * the wire tenant (the partition, or the signed tenant token). Omit when the app has no notion of
   * schedules; pass `items: []` to state it declares none (that lets the control plane withdraw
   * schedules the app stopped declaring).
   */
  schedules?: ScheduleAnnouncement;
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
    /** BullMQ's live-consumer count; the result publisher uses it to detect batch consumers. */
    getWorkersCount?(): Promise<number>;
  };
  /** Optional: the pub/sub + heartbeat client ctor. Omit and control/heartbeat are simply off. */
  Redis?: new (
    connection: RedisConnection,
  ) => {
    duplicate(): RedisSubClient;
    set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
    /** Worker registry hash commands (see `workerRegistry`); without them only the keys are written. */
    del?(...keys: string[]): Promise<unknown>;
    hset?(key: string, field: string, value: string): Promise<unknown>;
    hgetall?(key: string): Promise<Record<string, string>>;
    hdel?(key: string, ...fields: string[]): Promise<unknown>;
    pexpire?(key: string, ms: number): Promise<unknown>;
    /** Reply routing reads an engine's alive key; without it results go to the shared queue. */
    exists?(key: string): Promise<number>;
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

/** SDK identity stamped into the descriptor this runner advertises (observability only, never gates
 *  dispatch — see `WorkerDescriptor.sdk`). */
const SDK_NAME = '@dudousxd/durable-worker';

/** Process start time (epoch ms), captured once at import. Part of the descriptor's content hash, so
 *  a restart changes the ETag and a control plane re-reads (design §7.2). Mirrors the Python SDK's
 *  module-level `_PROCESS_STARTED_AT_MS` and the BullMQ transport's per-instance `startedAt`. */
const PROCESS_STARTED_AT = Date.now();

/**
 * This runner's handshake descriptor (design §7.1), including the workflows it ANNOUNCES it can
 * execute (§7.9). Each announcement's `group` is the token the runner subscribes for that workflow —
 * `tenantGroup(sanitizeQueueToken(name), partition)`, the SAME expression that built the queue this
 * process consumes — so the group is a queue this worker really reads, not a claim about one.
 *
 * Only workflows are announced. Step handler names still ride `steps` for capability routing, but
 * they are not an invocable catalog: a step is addressable only as a `(runId, seq)` position inside
 * one workflow's history (see the "steps are out of scope" note in core's `handshake/announced`).
 */
export function buildRunnerDescriptor(
  runtime: DurableWorkerRuntime,
  instanceId: string,
  partition?: string,
  startedAt: number = PROCESS_STARTED_AT,
  schedules?: ScheduleAnnouncement,
): WorkerDescriptor {
  const { workflows, steps } = runtime.registeredNames();
  const registrations: WorkflowRegistration[] = runtime.workflowRegistrations().map((reg) => ({
    ...reg,
    group: tenantGroup(sanitizeQueueToken(reg.name), partition),
  }));
  return describeWorker({
    instanceId,
    runtime: 'node',
    sdk: { name: SDK_NAME, version: '0' },
    steps,
    workflows,
    registrations,
    ...(schedules !== undefined ? { schedules } : {}),
    startedAt,
    partition,
  });
}

/** `concurrencyByHandler` names already warned about in this process. */
const warnedOverrides = new Set<string>();

/**
 * Warn, once per name per process, about `concurrencyByHandler` names this runner does not
 * subscribe. Several runners in one process (one per role or partition) often share one config, so
 * a name one of them serves is expected to be missing from the others.
 */
function warnUnregisteredOverrides(keys: string[], registered: Set<string>): void {
  const fresh = keys.filter((name) => !registered.has(name) && !warnedOverrides.has(name));
  if (fresh.length === 0) return;
  for (const name of fresh) warnedOverrides.add(name);
  console.warn(
    `[nestjs-durable] concurrencyByHandler names a workflow or step not registered by this process, ignored: ${fresh.join(', ')}`,
  );
}

/**
 * Start one BullMQ `Worker` per name in `runtime.registeredNames()` (workflows ∪ steps, deduped),
 * each consuming `<prefix>-tasks-<sanitized-name>[@<partition>]`, and drive the
 * {@link DurableWorkerRuntime} for every job across all of them.
 *
 * Each queue carries BOTH workflow tasks and remote step tasks dispatched at that name (the engine
 * adds them to the same per-name queue): every job is handed to `runtime.handleTask`, which routes
 * by shape and returns either a {@link import('@dudousxd/nestjs-durable-core').WorkflowDecision} —
 * published on `<prefix>-decisions` — or a {@link import('@dudousxd/nestjs-durable-core').StepResult}
 * — published on `<prefix>-results`. A thin Node port of the Python `run_redis_worker`, collapsed
 * into one runner because the TS `handleTask` discriminates the two task kinds itself.
 *
 * It also (best-effort): subscribes to `<prefix>-control` and feeds cancellation into the replay's
 * `isCancelled`; streams each local step's lifecycle onto `<prefix>-step-events`; and stamps a TTL'd
 * worker-liveness heartbeat key PER subscribed name, alongside the full handshake descriptor
 * ({@link buildRunnerDescriptor}) that ANNOUNCES the workflows this worker can execute — same key
 * TTL, same beat, so the announcement cannot outlive the worker. None of these can block the worker
 * from starting or processing.
 *
 * `await close()` on the returned handle to drain + stop every worker, the queues, and pub/sub.
 */
export async function runRedisWorker(options: RunRedisWorkerOptions): Promise<RunningWorker> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const instanceId = options.instanceId ?? `ts-${hostname()}-${process.pid}`;
  const lockDuration = positiveMs(options.lockDuration) ?? DEFAULT_LOCK_DURATION_MS;
  // Stall settings reach the Worker only when given, so BullMQ's own defaults stay the default.
  const stalledInterval = positiveMs(options.stalledInterval);
  const maxStalledCount =
    Number.isInteger(options.maxStalledCount) && (options.maxStalledCount as number) >= 0
      ? (options.maxStalledCount as number)
      : undefined;
  const deps = options.deps ?? (await loadDeps());
  const { runtime, partition } = options;
  // A `redis://` string becomes options: BullMQ would read a bare string as 127.0.0.1:6379.
  const connection = normalizeRedisConnection(options.connection);
  // One queue TOKEN per distinct registered name (workflows ∪ steps, deduped): the token IS the
  // routing address the engine dispatches that name's tasks on — `tenantGroup(sanitizeQueueToken(
  // name), partition)` — byte-identical to the expression the engine + transport use (Task 2/4).
  const { workflows, steps } = runtime.registeredNames();
  const names = [...new Set([...workflows, ...steps])];
  const queueTokens = names.map((name) => tenantGroup(sanitizeQueueToken(name), partition));

  const queueOpts = { connection };
  const decisions = new deps.Queue(decisionsName(prefix), queueOpts);
  // Results go back the way BullMQTransport sends them: routed to the engine instance holding the
  // parked body (`replyTo`), batched while an engine reads batches, else one job each.
  const publisher = new ResultPublisher(
    prefix,
    (name) => new deps.Queue(name, queueOpts),
    () => {
      const client = heartbeatClient;
      const exists = client?.exists;
      return exists ? { exists: (key: string) => exists.call(client, key) } : undefined;
    },
  );
  const stepEvents = new deps.Queue(stepEventsName(prefix), queueOpts);
  const jobOpts = { removeOnComplete: true, removeOnFail: true };

  // Cooperative cancellation: a Set of cancelled runIds fed by the control channel.
  const cancelled = new Set<string>();
  const isCancelled = (runId: string): boolean => cancelled.has(runId);

  // Best-effort step-event streaming: publish each local step's lifecycle live (never fail the turn).
  const onStep = (event: WorkflowStepEvent): void => {
    void stepEvents.add('stepEvent', event, jobOpts).catch(() => {});
  };

  // The concurrency controllers. The default one tracks inFlight + a rolling window of completions,
  // snapshots a live status for the heartbeat, and (adaptive mode) re-tunes the live limit, writing
  // the settable `concurrency` of every per-name Worker WITHOUT an override. Each name in
  // `concurrencyByHandler` gets its own controller governing that name's Worker alone, and its queue's
  // heartbeat reports that controller's status. `apply` reaches Workers constructed after the
  // controller: a controller never calls back before `start()`.
  type RunnerWorker = InstanceType<RunnerDeps['Worker']>;
  const overrides = options.concurrencyByHandler ?? {};
  warnUnregisteredOverrides(Object.keys(overrides), new Set(names));
  const defaultWorkers: RunnerWorker[] = [];
  const controller = new AdaptiveController({
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    apply: (limit) => {
      for (const w of defaultWorkers) w.concurrency = limit;
    },
  });
  const ownControllers: AdaptiveController[] = [];
  const allWorkers: RunnerWorker[] = [];
  /** The controller governing each subscribed queue token, read when building its heartbeat. */
  const controllerByToken = new Map<string, AdaptiveController>();

  const processJob = async (pool: AdaptiveController, job: { data: unknown }): Promise<void> => {
    const task = job.data as Parameters<DurableWorkerRuntime['handleTask']>[0];
    // While replaying a WORKFLOW turn, beat run-scoped liveness so the engine's heartbeat-rearmed
    // `advance` deadline never re-drives a worker that's alive-but-slow. Only workflow tasks carry a
    // run the engine awaits an `advance` for; a remote-step task is not beaten (harmless either way).
    // `task.group` is the FINAL routing token the engine already stamped at dispatch (Task 2) — the
    // exact queue this job arrived on — so it's used verbatim rather than recomputed here.
    const stopBeat =
      isWorkflowTask(task) && heartbeatClient
        ? startRunHeartbeat(heartbeatClient, prefix, task.group, task.runId)
        : () => {};
    const startedAt = performance.now();
    pool.onStart();
    let ok = false;
    try {
      // `handleTask` is async; awaiting it keeps the event loop free (step bodies await), so the job
      // lock can renew and the worker's heartbeat keeps stamping — no stall, no redeliver.
      const out = await runtime.handleTask(task, { onStep, isCancelled });
      if (out.kind === 'decision') {
        await decisions.add('decision', out.decision, jobOpts);
      } else {
        await publisher.publish(out.result, (task as { replyTo?: string }).replyTo);
      }
      ok = true;
    } finally {
      // One pool, two task kinds. Only step completions feed the adaptive measurement window; a
      // workflow turn's duration would corrupt the latency gradient (it suspends, it doesn't block).
      pool.onSettle(performance.now() - startedAt, ok, isWorkflowTask(task) ? 'workflow' : 'step');
      // Stop the run-scoped beat the moment the turn settles (success OR failure).
      stopBeat();
    }
  };

  names.forEach((name, i) => {
    const override = Object.hasOwn(overrides, name) ? overrides[name] : undefined;
    const workerOpts = {
      connection: workerConnection(connection),
      lockDuration,
      ...(stalledInterval !== undefined ? { stalledInterval } : {}),
      ...(maxStalledCount !== undefined ? { maxStalledCount } : {}),
    };
    const queue = tasksName(prefix, queueTokens[i] as string);
    if (override === undefined) {
      const worker = new deps.Worker(queue, (job) => processJob(controller, job), {
        ...workerOpts,
        concurrency: controller.initialLimit,
      });
      defaultWorkers.push(worker);
      allWorkers.push(worker);
      controllerByToken.set(queueTokens[i] as string, controller);
      return;
    }
    const holder: { worker?: RunnerWorker } = {};
    const own = new AdaptiveController({
      concurrency: override,
      apply: (limit) => {
        if (holder.worker) holder.worker.concurrency = limit;
      },
    });
    holder.worker = new deps.Worker(queue, (job) => processJob(own, job), {
      ...workerOpts,
      concurrency: own.initialLimit,
    });
    ownControllers.push(own);
    allWorkers.push(holder.worker);
    controllerByToken.set(queueTokens[i] as string, own);
  });
  // Start the AIMD loop for an adaptive worker; a fixed worker only takes its CPU baseline.
  controller.start();
  for (const own of ownControllers) own.start();

  // --- best-effort pub/sub control channel + worker-liveness heartbeat (mirror the Python SDK) ---
  let controlSub: RedisSubClient | undefined;
  let closing = false;
  let heartbeatClient: InstanceType<NonNullable<RunnerDeps['Redis']>> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let registry: RegistryWriter | undefined;

  if (deps.Redis) {
    try {
      const base = new deps.Redis(connection);
      // Subscribe blocks the client, so use a dedicated (duplicated) connection for it.
      controlSub = base.duplicate();
      // Best-effort like the rest of this block. The subscribe is queued until the connection is
      // ready and ioredis rejects it with "Connection is closed." if `close()` disconnects first;
      // unhandled, that rejection would terminate the process.
      void Promise.resolve(controlSub.subscribe(controlChannel(prefix))).catch((err: unknown) => {
        // Not silent: this channel carries `cancel`, so a failed subscribe (ACL, bad prefix) means
        // cancellations never reach this worker. Only the disconnect from our own close() is expected.
        if (closing) return;
        console.warn(
          `[nestjs-durable] worker control-channel subscribe failed; cancellations will not reach this worker: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      controlSub.on('message', (_channel, payload) => {
        // The channel also carries every lifecycle/step-event broadcast; only a cancel matters
        // here, so skip the JSON parse for anything that can't be one.
        if (!payload.includes('cancel')) return;
        try {
          const msg = JSON.parse(payload) as { kind?: string; runId?: string };
          if (msg.kind === 'cancel' && typeof msg.runId === 'string') cancelled.add(msg.runId);
        } catch {
          /* ignore malformed control messages */
        }
      });

      heartbeatClient = base;
      registry = new RegistryWriter(base, prefix, instanceId, options.workerRegistry);
      const writer = registry;
      // This worker's handshake descriptor, including what it ANNOUNCES it can execute (design
      // §7.9). Built ONCE: the registration surface is fixed before the first task is consumed (both
      // Nest registrars run in `onModuleInit`, this runner starts in `onApplicationBootstrap`), so
      // rebuilding it per beat would re-serialize identical bytes every 10s for nothing. The ETag is
      // hashed once for the same reason and reused on every beat.
      const descriptor = buildRunnerDescriptor(
        runtime,
        instanceId,
        partition,
        PROCESS_STARTED_AT,
        options.schedules,
      );
      const descriptorJson = JSON.stringify(descriptor);
      const etag = descriptorHash(descriptor);
      const beat = () => {
        // One entry PER subscribed name/partition token, so `listWorkerGroups()` reports liveness per
        // queue rather than one blended signal for a process that may serve several handlers. The
        // value is `{ts,status,descriptorHash}` JSON; the hash is the two-tier ETag that tells a
        // control plane when the descriptor changed (design §7.2). The descriptor rides the SAME
        // beat with the SAME TTL, so this worker's announcements cannot outlive its liveness.
        // Each queue reports the controller that governs it: one snapshot per controller per beat.
        const ts = Date.now();
        const values = new Map<AdaptiveController, string>();
        const heartbeatOf = (token: string): string => {
          const pool = controllerByToken.get(token) ?? controller;
          let value = values.get(pool);
          if (value === undefined) {
            value = JSON.stringify({ ts, status: pool.snapshot(), descriptorHash: etag });
            values.set(pool, value);
          }
          return value;
        };
        void writer
          .beat({
            tokens: queueTokens,
            heartbeat: heartbeatOf,
            descriptor: descriptorJson,
            ttlSeconds: WORKER_HEARTBEAT_TTL_SECONDS,
            heartbeatKey: (token) => workerHeartbeatKey(prefix, token, instanceId),
            descriptorKey: (token) => workerDescriptorKey(prefix, token, instanceId),
          })
          .catch(() => {});
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
      closing = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      controller.stop();
      for (const own of ownControllers) own.stop();
      // Leave the registry now rather than at expiry, so readers stop routing to this worker. Bounded:
      // an unreachable Redis must not hold the shutdown (the entries expire on their own anyway).
      if (registry) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          registry.remove(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, REGISTRY_REMOVE_WAIT_MS);
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      await Promise.all(allWorkers.map((w) => w.close()));
      await Promise.all([decisions.close(), publisher.close(), stepEvents.close()]);
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
  /** Typed, queryable run data merged into the run at creation. */
  searchAttributes?: SearchAttributes | undefined;
  /**
   * The customer (data tenant) the run belongs to, sent as a claim ({@link StartRunMessage.tenantId}):
   * the control plane keeps it only when this process's verified token grants `tenancy:*` or
   * `tenancy:<tenantId>`.
   */
  tenantId?: string | undefined;
  /** The kind of {@link tenantId}. */
  tenantKind?: string | undefined;
  /**
   * Start this version (see {@link StartRunMessage.version}). The control plane waits for a live
   * worker that declares it before starting the run.
   */
  version?: string | undefined;
  /** Dispatch priority stamped on the run. Higher wins. */
  priority?: number | undefined;
  /** Delayed start (epoch ms or a `Date`); sent as epoch ms. */
  startAt?: number | Date | undefined;
  /** A start-time concurrency quota, checked on the control plane (see {@link StartRunMessage.concurrency}). */
  concurrency?: StartRunMessage['concurrency'];
  /** The workflow's singleton key, evaluated by the caller (see {@link StartRunMessage.singleton}). */
  singleton?: StartRunMessage['singleton'];
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
  const queue = new Queue(queueName, { connection: normalizeRedisConnection(connection) });
  const msg: StartRunMessage = {
    tenant: opts.tenant,
    workflow: opts.workflow,
    input: opts.input,
  };
  if (opts.runId !== undefined) msg.runId = opts.runId;
  if (opts.tags !== undefined) msg.tags = opts.tags;
  if (opts.searchAttributes !== undefined) msg.searchAttributes = opts.searchAttributes;
  if (opts.tenantId !== undefined) {
    msg.tenantId = opts.tenantId;
    if (opts.tenantKind !== undefined) msg.tenantKind = opts.tenantKind;
  }
  // Start options: only the ones given, so a message with none is byte-identical to an older one
  // (and a control plane older than these fields reads it unchanged).
  if (opts.version !== undefined) msg.version = opts.version;
  if (opts.priority !== undefined) msg.priority = opts.priority;
  if (opts.startAt !== undefined) {
    msg.startAt = opts.startAt instanceof Date ? opts.startAt.getTime() : opts.startAt;
  }
  if (opts.concurrency !== undefined) msg.concurrency = opts.concurrency;
  if (opts.singleton !== undefined) msg.singleton = opts.singleton;
  try {
    await queue.add('startRun', msg, { removeOnComplete: true, removeOnFail: true });
  } finally {
    await queue.close();
  }
}
