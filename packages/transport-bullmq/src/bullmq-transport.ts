import { hostname } from 'node:os';
import { AdaptiveController, type ConcurrencyOption } from '@dudousxd/durable-worker';
import {
  type ControlMessage,
  type ControlPlane,
  type GroupHealth,
  type Heartbeat,
  type RemoteTask,
  type RunReply,
  type RunRequest,
  type StartRunMessage,
  type StepHandler,
  type StepResult,
  type TenantEvent,
  type Transport,
  type WorkerHeartbeat,
  type WorkerStatus,
  type WorkflowDecision,
  type WorkflowStepEvent,
  type WorkflowTask,
  runStepHandler,
  sanitizeQueueToken,
  tenantGroup,
} from '@dudousxd/nestjs-durable-core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

// Worker liveness heartbeat: a worker stamps a TTL'd key while it's consuming; the key expiring is
// the "this worker is gone/stalled" signal a monitor watches. TTL comfortably exceeds the interval
// so one slow refresh doesn't flap. Mirrors the Python SDK's `durable-worker-heartbeat:` key, so a
// mixed-language group (TS engine-side + Python workers) reports all its workers under one scan.
const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
const WORKER_HEARTBEAT_TTL_SECONDS = 35;

// BullMQ priority is the INVERSE of the durable engine's: BullMQ runs the LOWEST number first
// (1..2_097_151), while the engine's admission `priority` is "higher wins". We translate so one
// convention ("higher = more urgent") holds end-to-end. `BASELINE - p` keeps relative order (a
// higher `p` yields a lower — more urgent — BullMQ number), clamped into BullMQ's valid range.
// Centred on the range midpoint so callers have headroom both above and below the default.
const BROKER_PRIORITY_MAX = 2_097_151;
const BROKER_PRIORITY_BASELINE = 1_048_576;

/**
 * Map the engine's per-call `priority` (higher = more urgent, default/absent = unprioritised) onto a
 * BullMQ job `priority` (lower = more urgent). Returns `undefined` for an absent priority so the
 * default FIFO path is untouched. Note BullMQ treats jobs WITHOUT a priority as highest, so to make
 * priority meaningful on a queue, set it on the jobs you want ordered relative to one another.
 */
export function toBrokerPriority(priority?: number): number | undefined {
  if (priority == null) return undefined;
  const mapped = Math.round(BROKER_PRIORITY_BASELINE - priority);
  return Math.min(BROKER_PRIORITY_MAX, Math.max(1, mapped));
}

// Epoch values below this threshold are seconds (Python's `time.time()`), at/above are milliseconds
// (the TS SDKs). Normalise to ms. ~1e12 ms ≈ year 2001; ~1e12 s is year 33658 — unambiguous.
const EPOCH_MS_THRESHOLD = 1e12;

// How long a FAILED task job's payload is kept in Redis before BullMQ GCs it (see `dispatch()`). Long
// enough that a peer worker's stalled-check (default interval 30s, up to `maxStalledCount` cycles) has
// failed a crashed worker's job and the terminal-failure bridge has read its `RemoteTask` — but bounded
// so failed jobs don't accumulate unbounded.
const TASK_FAILED_RETENTION_SECONDS = 24 * 60 * 60;

// Default `pingIntervalMs` (see `BullMQTransportOptions`) for the shared subscriber watchdog.
const DEFAULT_PING_INTERVAL_MS = 30_000;
// How long a single watchdog PING may take before its subscriber connection is presumed dead.
const SUBSCRIBER_PING_TIMEOUT_MS = 5_000;
// Belt-and-suspenders TCP keepalive (ms) applied to connections THIS transport builds itself (see
// `redis()`) — makes a dead peer visible to the OS sooner. Not the primary defence: a `duplicate()`d
// caller-supplied instance inherits whatever the caller configured, so the ping watchdog (which works
// regardless of keepalive) is the layer that must catch a silent loss either way.
const DEFAULT_KEEPALIVE_MS = 10_000;

/**
 * Normalise the `pingIntervalMs` option: `undefined` → the default interval, `0`/`false` → disabled
 * (the watchdog never starts), any other number → itself (verbatim, including a caller's smaller
 * interval for short-lived tests).
 */
function normalizePingInterval(value: number | false | undefined): number | false {
  if (value === undefined) return DEFAULT_PING_INTERVAL_MS;
  if (value === false || value === 0) return false;
  return value;
}

/**
 * Narrow a FAILED task job's `data` to the {@link RemoteTask} fields the terminal-failure bridge needs
 * (runId/seq/stepId), WITHOUT an unsafe cast. Returns `undefined` for a job whose payload BullMQ has
 * already GC'd (`removeOnFail`) or a malformed job — so the bridge safely no-ops instead of publishing
 * a bogus result. `job.data` arrives as the broker's loosely-typed value; this is the one guarded gate.
 */
function failedTaskIdentity(
  data: unknown,
): { runId: string; seq: number; stepId: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if (!('runId' in data) || !('seq' in data) || !('stepId' in data)) return undefined;
  const { runId, seq, stepId } = data;
  if (typeof runId !== 'string' || typeof seq !== 'number' || typeof stepId !== 'string') {
    return undefined;
  }
  return { runId, seq, stepId };
}

/**
 * Parse a worker-heartbeat key value into `{ lastBeatAt, status? }`, accepting BOTH forms:
 *   - the new `{"ts":<epoch>,"status":<WorkerStatus>}` JSON (newer SDKs),
 *   - an older bare timestamp string (this SDK's ms / the Python SDK's seconds).
 * A bare number or a `ts` below {@link EPOCH_MS_THRESHOLD} is treated as seconds and scaled to ms.
 * Robust to a missing/garbled value (→ `lastBeatAt: 0`, no `status`).
 */
export function parseHeartbeatValue(raw: string | null): {
  lastBeatAt: number;
  status?: WorkerStatus;
} {
  if (raw == null) return { lastBeatAt: 0 };
  const trimmed = raw.trim();
  if (trimmed === '') return { lastBeatAt: 0 };

  const toMs = (n: number): number =>
    Number.isFinite(n) ? (n < EPOCH_MS_THRESHOLD ? n * 1000 : n) : 0;

  // Old bare-number form (no JSON braces): a plain ms/seconds timestamp.
  if (!trimmed.startsWith('{')) return { lastBeatAt: toMs(Number(trimmed)) };

  try {
    const parsed = JSON.parse(trimmed) as { ts?: unknown; status?: unknown };
    const ts = typeof parsed.ts === 'number' ? toMs(parsed.ts) : 0;
    const status =
      parsed.status && typeof parsed.status === 'object'
        ? (parsed.status as WorkerStatus)
        : undefined;
    return status !== undefined ? { lastBeatAt: ts, status } : { lastBeatAt: ts };
  } catch {
    // Malformed JSON — fall back to a numeric read so a partially-written value still yields a beat.
    return { lastBeatAt: toMs(Number(trimmed)) };
  }
}

export interface BullMQTransportOptions {
  /** ioredis connection options (or an IORedis instance). */
  connection: ConnectionOptions;
  /**
   * Logical isolation partition suffixing every per-handler tasks queue this instance subscribes to
   * (via {@link tenantGroup}) — e.g. so several isolated worker pools can share one Redis without a
   * `handle()`d name colliding across pools. Optional: unset routes each handler to the bare
   * (sanitized) handler name, with no suffix.
   */
  partition?: string;
  /** Key prefix namespacing the durable queues. Defaults to `durable`. */
  prefix?: string;
  /**
   * Logical deployment namespace, segmenting every queue/stream/key so the same Redis can host
   * multiple isolated deployments (e.g. per-developer `dev-alice`) without crosstalk. Unset or
   * `"default"` keeps names BYTE-IDENTICAL to the un-namespaced scheme (production is unchanged); any
   * other value inserts a `-<namespace>` segment after the prefix — see the cross-SDK naming rule on
   * {@link BullMQTransport}. Construction-time ONLY, an explicit whole-deployment isolation knob:
   * the engine never infers it, and per-run TENANT routing is a different axis entirely (group
   * suffixes — `<name>@<tenant>` — on this transport's own prefix; see `tenantGroup`).
   */
  namespace?: string;
  /** Stable id for this worker process in heartbeats. Defaults to `ts-<hostname>-<pid>`. */
  instanceId?: string;
  /**
   * How many tasks this instance runs concurrently from its group's queue (the BullMQ Worker
   * concurrency). Defaults to 1 (one task at a time). Raise it so a fanned-out batch (e.g. the N
   * remote steps of a `gather`) executes in parallel instead of serially. Per worker process; total
   * parallelism is `concurrency × replicas`.
   *
   * Pass `'adaptive'` (or `{ mode:'adaptive', ... }`) to let an {@link AdaptiveController} self-tune
   * the limit (latency gradient + RAM brake + backpressure). The worker's live status rides its
   * heartbeat in both modes — see {@link BullMQTransport.groupHealth} → {@link WorkerHeartbeat.status}.
   */
  concurrency?: ConcurrencyOption;
  /**
   * How often (ms) the shared subscriber watchdog PINGs every pub/sub subscriber connection this
   * transport owns (`onControl`, `onHeartbeat`, `onRunReply`, `onTenantEvent`) to detect — and
   * recover from — a silent connection loss. A subscriber connection never WRITEs on its own (it
   * only ever receives PUBLISHed messages), so when a VPN/NAT/idle-timeout drops the underlying TCP
   * connection, ioredis has nothing that would surface the loss: no write ever fails, no timeout
   * ever fires, and the connection sits "subscribed" forever while the server's `PUBSUB NUMSUB`
   * already shows 0 — every control-plane call blocks until the process restarts. `PING` is legal in
   * subscriber mode; a rejection or timeout means the connection is dead, so we `disconnect(true)`
   * it — ioredis's `retryStrategy` reconnects and `autoResubscribe` (default `true`) resubscribes
   * every channel automatically. Pass `0` or `false` to disable the watchdog entirely (e.g. a
   * short-lived test where the interval would otherwise outlive the test). Default `30_000`.
   */
  pingIntervalMs?: number | false;
  /**
   * Wall-clock ceiling (ms) for a single step handler on THIS worker. A wedged handler — an await
   * that will never settle (dead connection swallowed by a wrapper stream, an external call with no
   * timeout) — otherwise holds its BullMQ job forever: the lock renews on a timer regardless of
   * progress, so the job is never reclaimed and the run waits until someone kills the process. When
   * set, a step still pending after `stepTimeoutMs` publishes a RETRYABLE failed StepResult (the
   * engine's durable retry re-dispatches it) and the orphaned handler promise is abandoned. Opt-in:
   * pick a value comfortably above your slowest legitimate step. Unset = no ceiling (previous
   * behavior).
   */
  stepTimeoutMs?: number;
}

/**
 * A queue-backed `Transport` over BullMQ/Redis — the path for true cross-process and
 * cross-language steps (e.g. a Python worker on the same queues). Steps are dispatched to a
 * queue named after their routing token (handler name, optionally partition-suffixed — see
 * {@link tenantGroup}); results come back on a shared results queue.
 *
 * Run one instance engine-side (consumes results) and one per worker process, registering a
 * `handle()` per handler name — each gets its OWN dedicated tasks queue/`Worker`, so a routing
 * token only one handler answers to never collides with another handler's queue. The wire payload
 * is the documented `RemoteTask`/`StepResult` JSON, so non-Node workers interoperate.
 */
export class BullMQTransport implements Transport, ControlPlane {
  private readonly connection: ConnectionOptions;
  private readonly partition: string | undefined;
  private readonly prefix: string;
  // Logical deployment namespace folded into every name via `#effectivePrefix()`. Construction-time
  // ONLY — an explicit deployment-isolation knob, never inferred: the engine does NOT push its
  // tenancy namespace onto transports (per-run tenant routing rides GROUP suffixes instead, the
  // cross-SDK canonical convention every worker runtime speaks).
  readonly #namespace: string | undefined;
  private readonly handlers = new Map<string, StepHandler>();
  private readonly queues = new Map<string, Queue>();
  // One BullMQ `Worker` per registered handler name (see `handle()`) — never a single shared queue.
  private readonly taskWorkers = new Map<string, Worker>();
  private resultsWorker?: Worker;
  private decisionsWorker?: Worker;
  private stepEventsWorker?: Worker;
  private startRunWorker?: Worker;
  private runRequestWorker?: Worker;
  // Control plane runs over Redis pub/sub (not a queue): every instance gets every message, which
  // is what live-tail + cancellation need. Subscribe needs its own connection (it blocks the client).
  private controlPub?: Redis;
  private controlSub?: Redis;
  // Heartbeats also ride Redis pub/sub: a worker on the long-step path beats so the engine on
  // another pod keeps the liveness window open (the in-memory `timeoutMs` path).
  private heartbeatPub?: Redis;
  private heartbeatSub?: Redis;
  // RunReply is shared pub/sub (every tenant worker subscribes and filters by `requestId`), same
  // shape as control/heartbeat above.
  private runReplyPub?: Redis;
  private runReplySub?: Redis;
  // TenantEvent is PER-TENANT pub/sub: unlike control/heartbeat/runReply (one subscription for the
  // whole transport), `onTenantEvent` can be called for several tenants — or several times for the
  // same tenant — each getting its own dedicated subscriber connection so it can unsubscribe/close
  // independently via the returned unsubscribe fn. `close()` tears down whatever's left.
  private tenantEventPub?: Redis;
  private readonly tenantEventSubs = new Set<Redis>();
  // Worker liveness (distinct from the long-step `heartbeat()` pub/sub above): a TTL'd key refreshed
  // on a timer while this instance is acting as a worker, + a client for reading peers' keys.
  private readonly instanceId: string;
  private readonly concurrency: ConcurrencyOption | undefined;
  // The shared concurrency controller, created when this instance becomes a worker (`handle()`), or
  // lazily in fixed mode for the heartbeat status if a beat fires without one. Tracks inFlight + a
  // completion window across ALL per-handler task workers, snapshots the heartbeat status, and
  // (adaptive) re-tunes every entry in `taskWorkers`' concurrency.
  private workerController?: AdaptiveController;
  private workerHeartbeatTimer?: ReturnType<typeof setInterval>;
  private workerHeartbeatRedis?: Redis;
  // Per-handler heartbeat tokens beaten on the single shared `workerHeartbeatTimer` — one entry per
  // `handle()`d name (its `tenantGroup(sanitizeQueueToken(name), partition)` queue token).
  private readonly heartbeatTokens = new Set<string>();
  // Every pub/sub SUBSCRIBER connection this transport owns (control/heartbeat/runReply's single
  // subscription plus every per-tenant one in `tenantEventSubs`) — the shared ping watchdog below
  // iterates this set. PUBLISH-only connections (`controlPub`, `heartbeatPub`, …) are never added:
  // they actively write, so a dead connection surfaces on their next `publish()` instead of silently.
  private readonly subscribers = new Set<Redis>();
  private pingWatchdogTimer?: ReturnType<typeof setInterval>;
  private readonly pingIntervalMs: number | false;
  private readonly stepTimeoutMs: number | undefined;

  constructor(options: BullMQTransportOptions) {
    this.connection = options.connection;
    this.partition = options.partition;
    this.prefix = options.prefix ?? 'durable';
    this.#namespace = options.namespace;
    this.instanceId = options.instanceId ?? `ts-${hostname()}-${process.pid}`;
    this.concurrency = options.concurrency;
    this.pingIntervalMs = normalizePingInterval(options.pingIntervalMs);
    this.stepTimeoutMs = options.stepTimeoutMs;
  }

  /**
   * The prefix every name is built from, folding in the namespace per the cross-SDK rule: a set,
   * non-`"default"` namespace appends `-<namespace>`; otherwise the bare prefix (so the un-namespaced
   * and `"default"` schemes are byte-identical — production names never change). Keep ALL name
   * builders routed through this; a single direct `this.prefix` would split an engine from its workers.
   */
  #effectivePrefix(): string {
    return this.#namespace && this.#namespace !== 'default'
      ? `${this.prefix}-${this.#namespace}`
      : this.prefix;
  }

  /** `<effectivePrefix>-start-run` — the queue for tenant worker → control plane start-run requests. */
  #startRunName(): string {
    return `${this.#effectivePrefix()}-start-run`;
  }

  /** `<effectivePrefix>-run-request` — the queue for tenant worker → control plane read/control
   *  requests ({@link RunRequest}). */
  #runRequestName(): string {
    return `${this.#effectivePrefix()}-run-request`;
  }

  /** The shared controller, lazily created. In `handle()` it's created with the configured
   *  `concurrency`; if a heartbeat beats before any handler registered, this seeds a minimal
   *  fixed-mode controller so the status payload is never empty. Idempotent. */
  private controller(): AdaptiveController {
    if (!this.workerController) {
      this.workerController = new AdaptiveController({
        ...(this.concurrency !== undefined ? { concurrency: this.concurrency } : {}),
        apply: (limit) => {
          for (const worker of this.taskWorkers.values()) worker.concurrency = limit;
        },
      });
    }
    return this.workerController;
  }

  // BullMQ queue names must not contain ':' (its Redis key separator), so use '-'. `routingToken` is
  // already the FINAL token (a `sanitizeQueueToken`d handler name, optionally `tenantGroup`-suffixed
  // with a partition) — callers compute it, this just folds in the effective prefix.
  private tasksName(routingToken: string): string {
    return `${this.#effectivePrefix()}-tasks-${routingToken}`;
  }

  /**
   * A `@tenant`-suffixed routing token follows the OPERATOR convention: tenant workers (the Python
   * SDK, the TS `role: 'tenant'` worker) subscribe `<name>@<tenant>` queues under the BARE prefix.
   * Enqueueing such a token under a NAMESPACED prefix (`durable-<ns>-tasks-<name>@<tenant>`) is a
   * double encoding of the tenant axis — no worker anywhere subscribes that queue, so the task would
   * park invisibly forever (the exact black hole that hid a misrouted remote `processing` workflow).
   * Refuse loudly instead: the engine's dispatch failover (TransportPool) moves on to the next
   * transport in the pool, so a control plane that pairs a namespaced transport with a bare-prefix
   * one (`new BullMQTransport({ connection, namespace: 'default' })`) routes these tokens correctly.
   */
  #assertRoutableToken(routingToken: string): void {
    const ns = this.#namespace;
    if (ns && ns !== 'default' && routingToken.includes('@')) {
      throw new Error(
        `routing token "${routingToken}" carries a tenant suffix, but this transport is namespaced "${ns}" (keys live under "${this.prefix}-${ns}-*") — tenant-suffixed groups follow the operator convention and live on the BARE prefix. Add a bare-prefix transport to the pool (e.g. new BullMQTransport({ connection, namespace: 'default' })) so dispatch fails over to it, or unset the tenant on this deployment.`,
      );
    }
  }
  private resultsName(): string {
    return `${this.#effectivePrefix()}-results`;
  }

  /** Workers require `maxRetriesPerRequest: null`; preserve a passed-in IORedis instance as-is. */
  private workerConnection(): ConnectionOptions {
    if (this.connection && typeof this.connection === 'object' && !('options' in this.connection)) {
      return { ...this.connection, maxRetriesPerRequest: null };
    }
    return this.connection;
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Job options shared by step/workflow dispatch — adds a translated `priority` only when set. */
  private jobOptions(priority?: number): {
    removeOnComplete: true;
    removeOnFail: true;
    priority?: number;
  } {
    const brokerPriority = toBrokerPriority(priority);
    return {
      removeOnComplete: true,
      removeOnFail: true,
      ...(brokerPriority != null ? { priority: brokerPriority } : {}),
    };
  }

  /** `task.group` already carries the FINAL routing token (`tenantGroup(sanitizeQueueToken(name),
   *  partition)`), computed upstream by the engine — this targets that handler's dedicated queue. */
  async dispatch(task: RemoteTask): Promise<void> {
    this.#assertRoutableToken(task.group);
    await this.queue(this.tasksName(task.group)).add('task', task, {
      ...this.jobOptions(task.priority),
      // Retain a FAILED task job's payload (age-bounded) instead of deleting it. A worker that
      // crashes/stalls has its job failed by a PEER worker's stalled-check, and BullMQ's
      // `removeOnFail: true` Lua path deletes the job hash in the SAME transaction it emits `failed`
      // — leaving the terminal-failure bridge (see `handle()`) no `RemoteTask` to rebuild a
      // StepResult from. Keeping it briefly lets the bridge settle the run's `pending` checkpoint
      // (and doubles as failure forensics); BullMQ GCs it after the window.
      removeOnFail: { age: TASK_FAILED_RETENTION_SECONDS },
    });
  }

  private decisionsName(): string {
    return `${this.#effectivePrefix()}-decisions`;
  }

  /** engine → workflow worker: a WorkflowTask on the workflow's dedicated task queue (same queue a
   *  Python workflow worker consumes via `<prefix>-tasks-<routing-token>`). The decision comes back
   *  on `<prefix>-decisions`. */
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.#assertRoutableToken(task.group);
    await this.queue(this.tasksName(task.group)).add(
      'workflow',
      task,
      this.jobOptions(task.priority),
    );
  }

  /** workflow worker → engine: consume replayed decisions. Starts the consumer on first call. */
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    if (this.decisionsWorker) return;
    this.decisionsWorker = new Worker(
      this.decisionsName(),
      (job) => handler(job.data as WorkflowDecision),
      { connection: this.workerConnection() },
    );
  }

  private stepEventsName(): string {
    return `${this.#effectivePrefix()}-step-events`;
  }

  /** workflow worker → engine: stream a local step's lifecycle. Point-to-point on its own queue, so a
   *  single engine instance consumes each event and checkpoints it once (no cross-pod duplicate writes). */
  async dispatchStepEvent(event: WorkflowStepEvent): Promise<void> {
    await this.queue(this.stepEventsName()).add('stepEvent', event, {
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /** engine ← workflow worker: consume streamed step lifecycle events. Starts the consumer on first call. */
  onStepEvent(handler: (event: WorkflowStepEvent) => Promise<void>): void {
    if (this.stepEventsWorker) return;
    this.stepEventsWorker = new Worker(
      this.stepEventsName(),
      (job) => handler(job.data as WorkflowStepEvent),
      { connection: this.workerConnection() },
    );
  }

  /**
   * Register a step handler (worker side). Starts a DEDICATED task consumer for `name` on first
   * registration — one BullMQ `Worker` per handler name, each on its own `tasksName` queue (via
   * {@link tenantGroup}/{@link sanitizeQueueToken}), never a single queue shared across handlers.
   * Re-registering an already-`handle()`d name just swaps the handler fn; its worker is untouched.
   */
  handle(name: string, fn: StepHandler): void {
    this.handlers.set(name, fn);
    if (this.taskWorkers.has(name)) return;
    const controller = this.controller();
    const routingToken = tenantGroup(sanitizeQueueToken(name), this.partition);
    const worker = new Worker(this.tasksName(routingToken), (job) => this.runTask(job.data), {
      connection: this.workerConnection(),
      concurrency: controller.initialLimit,
    });
    // Terminal-failure bridge. A task job reaching a TERMINAL `failed` state is ALWAYS an
    // INFRASTRUCTURE failure, never a handler business error: `runStepHandler` catches every handler
    // throw and `runTask` publishes a failed StepResult for it (so the job SUCCEEDS). `failed` fires
    // only for a worker crash / stalled-count exhaustion / an unexpected throw in `runTask` (e.g. a
    // Redis publish failure) — none of which produce a StepResult, so without this the run hangs on
    // its `pending` checkpoint forever. We bridge that back into a synthetic failed StepResult so the
    // engine settles the checkpoint and its durable retry re-dispatches the step.
    //
    // We use the Worker `'failed'` listener over a separate `QueueEvents('failed')`. BullMQ's
    // stalled-check runs ON a live Worker and emits `failed` WITH the (re-fetched) job, whereas
    // `QueueEvents('failed')` carries only a jobId — and by then the failed job's hash has been GC'd
    // (see `dispatch()`'s `removeOnFail`), so QueueEvents could not recover the `RemoteTask` to
    // rebuild the result. A PEER replica's Worker fails a CRASHED worker's stalled job, so this
    // listener still fires cross-process. Cleanup is inherent: the listener rides the per-handler
    // Worker, which `close()` already tears down (no new connection/QueueEvents to leak).
    //
    // Residual gap: if the SOLE worker crashes and never restarts, no stalled-check ever runs, so
    // nothing — Worker OR QueueEvents — can settle it; that needs an external liveness monitor.
    worker.on('failed', (job, error) => {
      const identity = failedTaskIdentity(job?.data);
      if (!identity) return; // payload already GC'd or malformed — nothing safe to publish
      void this.bridgeTaskFailure(identity, job?.failedReason ?? error.message ?? 'unknown');
    });
    this.taskWorkers.set(name, worker);
    // Run the shared control loop (idempotent across handlers): fixed mode just tracks status;
    // adaptive mode also re-tunes every `taskWorkers` entry's concurrency.
    controller.start();
    // This instance is now a worker for `routingToken` — start stamping its liveness heartbeat.
    this.startWorkerHeartbeat(routingToken);
  }

  private workerHeartbeatKey(routingToken: string, instanceId: string): string {
    return `${this.#effectivePrefix()}-worker-heartbeat:${routingToken}:${instanceId}`;
  }

  /** Lazily-created standalone client for the worker-heartbeat keys (writes + scans), reused so a
   *  worker doesn't open a fresh connection per beat/read. */
  private workerRedis(): Redis {
    if (!this.workerHeartbeatRedis) this.workerHeartbeatRedis = this.redis();
    return this.workerHeartbeatRedis;
  }

  /** Refresh EVERY `handle()`d name's TTL'd liveness key on ONE shared interval until `close()` —
   *  each handler name keeps its own key (`workerHeartbeatKey(routingToken, instanceId)`) so
   *  `groupHealth`/`listWorkerGroups` still resolve liveness per per-handler queue. Best-effort: a
   *  failed refresh is swallowed (the key then expires, and that gap is itself the signal). A newly
   *  added token beats immediately so a freshly-registered handler is visible without waiting a full
   *  interval. */
  private startWorkerHeartbeat(routingToken: string): void {
    const client = this.workerRedis();
    const controller = this.controller();
    const beatOne = (token: string) => {
      const key = this.workerHeartbeatKey(token, this.instanceId);
      // Value is now `{ts,status}` JSON (was a bare ms timestamp); `listLiveWorkers` reads both forms.
      const value = JSON.stringify({ ts: Date.now(), status: controller.snapshot() });
      void client.set(key, value, 'EX', WORKER_HEARTBEAT_TTL_SECONDS).catch(() => {});
    };
    const isNewToken = !this.heartbeatTokens.has(routingToken);
    this.heartbeatTokens.add(routingToken);
    if (isNewToken) beatOne(routingToken);
    if (this.workerHeartbeatTimer) return;
    this.workerHeartbeatTimer = setInterval(() => {
      for (const token of this.heartbeatTokens) beatOne(token);
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    // Don't keep the event loop alive just for the heartbeat (a worker should exit when idle-closing).
    this.workerHeartbeatTimer.unref?.();
  }

  /** Distinct routing tokens with a live worker heartbeat, discovered by scanning the heartbeat
   *  keyspace. A key is `<prefix>-worker-heartbeat:<routingToken>:<instanceId>` and neither segment
   *  carries a `:`, so the token is the segment between the fixed prefix and the next `:`. */
  async listWorkerGroups(): Promise<string[]> {
    const client = this.workerRedis();
    const prefix = `${this.#effectivePrefix()}-worker-heartbeat:`;
    const groups = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const sep = rest.indexOf(':');
        const group = sep === -1 ? rest : rest.slice(0, sep);
        if (group) groups.add(group);
      }
    } while (cursor !== '0');
    return [...groups];
  }

  async groupHealth(group: string): Promise<GroupHealth> {
    const counts = await this.queue(this.tasksName(group)).getJobCounts(
      'waiting',
      'active',
      'delayed',
      'prioritized',
    );
    const depth = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    return { group, depth, liveWorkers: await this.listLiveWorkers(group) };
  }

  /** Live workers for `group`: SCAN the heartbeat keys (never KEYS — it blocks Redis) and read each.
   *  A returned key is live by definition (the TTL hasn't expired). Tolerates BOTH heartbeat value
   *  forms: the new `{ts,status}` JSON (newer SDKs — populates `status` + `lastBeatAt`) and an older
   *  bare timestamp (this SDK's ms / the Python SDK's seconds — `lastBeatAt` only, `status` undefined). */
  private async listLiveWorkers(group: string): Promise<WorkerHeartbeat[]> {
    const client = this.workerRedis();
    const match = this.workerHeartbeatKey(group, '*');
    const prefix = this.workerHeartbeatKey(group, '');
    const workers: WorkerHeartbeat[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const raw = await client.get(key);
        const parsed = parseHeartbeatValue(raw);
        workers.push({
          group,
          instanceId: key.slice(prefix.length),
          lastBeatAt: parsed.lastBeatAt,
          ...(parsed.status !== undefined ? { status: parsed.status } : {}),
        });
      }
    } while (cursor !== '0');
    return workers;
  }

  private async runTask(task: RemoteTask): Promise<void> {
    // Track the task in the controller (inFlight + duration/ok window) so the heartbeat status and the
    // adaptive loop see it. A handler that throws (failed result) still counts as a settled completion.
    const controller = this.controller();
    const startedAt = Date.now();
    controller.onStart();
    let ok = false;
    try {
      const result = await this.withStepTimeout(
        task,
        runStepHandler(task, this.handlers.get(task.name)),
      );
      ok = result.status === 'completed';
      await this.queue(this.resultsName()).add('result', result, {
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch {
      // In-process safety net for a crash we DIDN'T die from. `runStepHandler` is pure — it never
      // throws (it returns a failed StepResult), so reaching here means the results-queue publish
      // itself threw (e.g. Redis blipped). We still hold `task`, so synthesize a failed StepResult
      // rather than let the engine's checkpoint hang on `pending`. We can't tell whether the
      // un-published result was completed or failed, so we fail it RETRYABLE and let the engine
      // re-dispatch (remote steps are already at-least-once; `completeRemoteResult` no-ops a
      // checkpoint that's no longer `pending`, so any duplicate from the terminal-failure bridge is
      // harmless). If THIS publish ALSO throws it propagates → the BullMQ job is marked `failed` →
      // the terminal-failure bridge + durable retry become the last line of defence.
      const fallback: StepResult = {
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'failed',
        error: { message: 'remote step worker failed: result publish error', retryable: true },
      };
      await this.queue(this.resultsName()).add('result', fallback, {
        removeOnComplete: true,
        removeOnFail: true,
      });
    } finally {
      // The engine-side task worker runs STEP handlers only (`runStepHandler`), so every settlement
      // is a step — it feeds the adaptive measurement window. Workflow turns are replayed by the SDK
      // worker (`redis-runner`), never here.
      controller.onSettle(Date.now() - startedAt, ok, 'step');
    }
  }

  /**
   * Race a step handler against the configured `stepTimeoutMs` ceiling. On timeout, resolve with a
   * RETRYABLE failed StepResult — the engine's durable retry re-dispatches the step — and ABANDON
   * the still-pending handler promise (a wedged await cannot be cancelled from outside; what matters
   * is that the run stops waiting on a worker that will never answer). No ceiling configured →
   * pass-through.
   */
  private withStepTimeout(task: RemoteTask, run: Promise<StepResult>): Promise<StepResult> {
    const ms = this.stepTimeoutMs;
    if (!ms) return run;
    return new Promise<StepResult>((resolve) => {
      const timedOut: StepResult = {
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'failed',
        error: {
          message: `remote step worker failed: step exceeded stepTimeoutMs (${ms}ms) — presumed wedged`,
          retryable: true,
        },
      };
      const timer = setTimeout(() => resolve(timedOut), ms);
      timer.unref?.();
      // runStepHandler is pure (a handler throw becomes a failed StepResult), but guard anyway so a
      // future refactor can't turn a rejection into an unhandled one that skips the settle path.
      run.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err: unknown) => {
          clearTimeout(timer);
          resolve({
            ...timedOut,
            error: {
              message: `remote step worker failed: ${err instanceof Error ? err.message : String(err)}`,
              retryable: true,
            },
          });
        },
      );
    });
  }

  /**
   * Publish a synthetic FAILED {@link StepResult} for a task job that failed at the INFRASTRUCTURE
   * level (worker crash / stalled-count exhaustion) — which produces no normal result. Routing it
   * through the SAME results queue means the engine's ordinary `onResult` → `completeRemoteResult`
   * path settles the checkpoint `failed` and its durable retry re-dispatches the step, instead of the
   * run hanging on a `pending` checkpoint forever. `retryable: true` so a transient crash is retried,
   * not dead-lettered. NOTE: `StepResult` carries NO `name` field (see core `interfaces.ts`) — the
   * engine correlates purely by runId/seq/stepId, so we don't invent one. Best-effort: a publish
   * failure here is swallowed (the engine's own reconcile is the last resort); a duplicate is a no-op
   * on a non-`pending` checkpoint.
   */
  private async bridgeTaskFailure(
    identity: { runId: string; seq: number; stepId: string },
    reason: string,
  ): Promise<void> {
    const result: StepResult = {
      runId: identity.runId,
      seq: identity.seq,
      stepId: identity.stepId,
      status: 'failed',
      error: { message: `remote step worker failed: ${reason}`, retryable: true },
    };
    try {
      await this.queue(this.resultsName()).add('result', result, {
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch {
      /* best-effort — the durable engine's reconcile path is the last line of defence */
    }
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.resultsWorker = new Worker(this.resultsName(), (job) => handler(job.data as StepResult), {
      connection: this.workerConnection(),
    });
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    if (this.heartbeatSub) return; // one subscription per transport
    this.heartbeatSub = this.subscriberRedis();
    void this.heartbeatSub.subscribe(this.heartbeatChannel());
    this.heartbeatSub.on('message', (_channel, payload) => {
      try {
        void handler(JSON.parse(payload) as Heartbeat);
      } catch {
        /* ignore malformed heartbeats */
      }
    });
  }

  /** Worker side: publish a liveness heartbeat for an in-flight long step (resets the engine's
   *  `timeoutMs` window on whichever pod is awaiting it). */
  async heartbeat(beat: Heartbeat): Promise<void> {
    if (!this.heartbeatPub) this.heartbeatPub = this.redis();
    await this.heartbeatPub.publish(this.heartbeatChannel(), JSON.stringify(beat));
  }

  private controlChannel(): string {
    return `${this.#effectivePrefix()}-control`;
  }

  private heartbeatChannel(): string {
    return `${this.#effectivePrefix()}-heartbeat`;
  }

  /** `<effectivePrefix>-run-reply` — shared channel for {@link RunReply}s; every tenant worker
   *  subscribes and filters by `requestId` client-side. */
  private runReplyChannel(): string {
    return `${this.#effectivePrefix()}-run-reply`;
  }

  /** `<effectivePrefix>-tenant-events-<tenant>` — per-tenant channel for re-published
   *  {@link TenantEvent}s, so a store-less tenant worker live-tails only ITS OWN runs. */
  private tenantEventChannel(tenant: string): string {
    return `${this.#effectivePrefix()}-tenant-events-${tenant}`;
  }

  /** A standalone Redis client from the same connection — duplicating a passed-in instance, or
   *  building one from options (pub/sub can't share BullMQ's worker connections). A caller-supplied
   *  instance's own options win as-is (`duplicate()` inherits them); a freshly-built one gets a
   *  keepalive floor (`DEFAULT_KEEPALIVE_MS`) unless the passed options already set one. */
  private redis(): Redis {
    const c = this.connection;
    if (c instanceof Redis) return c.duplicate();
    return new Redis({ keepAlive: DEFAULT_KEEPALIVE_MS, ...(c as RedisOptions) });
  }

  /**
   * A subscriber-mode connection: the same underlying connection as `redis()`, but registered with
   * the shared ping watchdog and a de-duplicated `error` listener (see `trackSubscriber`) — every
   * `onControl`/`onHeartbeat`/`onRunReply`/`onTenantEvent` subscriber goes through here instead of
   * `redis()` directly, since (unlike a publish-only connection) it never writes on its own and so
   * can't surface a silent connection loss by itself.
   */
  private subscriberRedis(): Redis {
    const sub = this.redis();
    this.trackSubscriber(sub);
    return sub;
  }

  /**
   * Register `sub` with the shared ping watchdog (starting it if this is the first subscriber) and
   * attach a de-duplicated `error` listener — an unhandled `error` event on an ioredis instance
   * crashes the process in some setups, and a dead/reconnecting subscriber can emit a burst of them.
   */
  private trackSubscriber(sub: Redis): void {
    this.subscribers.add(sub);
    let loggedSinceReady = false;
    sub.on('error', (err: Error) => {
      if (loggedSinceReady) return; // one line per reconnect burst, not one per retry
      loggedSinceReady = true;
      console.warn(`[nestjs-durable] subscriber connection error: ${err.message}`);
    });
    sub.on('ready', () => {
      loggedSinceReady = false;
    });
    this.startPingWatchdog();
  }

  /**
   * Start the ONE shared interval that PINGs every subscriber connection this transport owns, if
   * `pingIntervalMs` is enabled and it isn't already running (idempotent — one interval total, never
   * one per connection). Unref'd so it never keeps the process alive on its own; torn down in
   * `close()`.
   */
  private startPingWatchdog(): void {
    if (this.pingWatchdogTimer || this.pingIntervalMs === false) return;
    this.pingWatchdogTimer = setInterval(() => {
      for (const sub of this.subscribers) void this.pingSubscriber(sub);
    }, this.pingIntervalMs);
    this.pingWatchdogTimer.unref?.();
  }

  /**
   * PING one subscriber connection (legal in subscriber mode — see ioredis's
   * `VALID_IN_SUBSCRIBER_MODE`); on rejection or timeout, `disconnect(true)` it so ioredis's
   * `retryStrategy` reconnects and `autoResubscribe` restores its channel. Skips a connection that
   * isn't `'ready'` — it's already mid-(re)connect, so a fresh ping would just race that cycle.
   *
   * The timeout is capped at `pingIntervalMs` itself (never above `SUBSCRIBER_PING_TIMEOUT_MS`):
   * waiting longer than the gap between checks to declare one dead would just mean two checks race
   * each other, and it lets a short `pingIntervalMs` (e.g. in a test) shrink the whole detect →
   * reconnect cycle instead of always eating the full multi-second default.
   */
  private async pingSubscriber(sub: Redis): Promise<void> {
    if (sub.status !== 'ready') return;
    const timeoutMs =
      this.pingIntervalMs === false
        ? SUBSCRIBER_PING_TIMEOUT_MS
        : Math.min(SUBSCRIBER_PING_TIMEOUT_MS, this.pingIntervalMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ping timed out')), timeoutMs);
        sub
          .ping()
          .then(() => {
            clearTimeout(timer);
            resolve();
          })
          .catch((err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[nestjs-durable] subscriber connection unresponsive (${message}) — reconnecting to restore its subscription`,
      );
      sub.once('subscribe', () => {
        console.warn('[nestjs-durable] subscriber connection reconnected and resubscribed');
      });
      sub.disconnect(true);
    }
  }

  async publishControl(msg: ControlMessage): Promise<void> {
    if (!this.controlPub) this.controlPub = this.redis();
    await this.controlPub.publish(this.controlChannel(), JSON.stringify(msg));
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    if (this.controlSub) return; // one subscription per transport
    this.controlSub = this.subscriberRedis();
    void this.controlSub.subscribe(this.controlChannel());
    this.controlSub.on('message', (_channel, payload) => {
      try {
        handler(JSON.parse(payload) as ControlMessage);
      } catch {
        /* ignore malformed control messages */
      }
    });
  }

  /** Tenant worker → control plane: enqueue a start-run request on `<effectivePrefix>-start-run`. */
  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    await this.queue(this.#startRunName()).add('startRun', msg, {
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /** Control plane: consume start-run requests and turn them into durable runs. Starts the consumer
   *  on first call (idempotent — a second call is a no-op). */
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    if (this.startRunWorker) return;
    this.startRunWorker = new Worker(
      this.#startRunName(),
      (job) => handler(job.data as StartRunMessage),
      { connection: this.workerConnection() },
    );
  }

  /** Tenant worker → control plane: enqueue a read/control request on `<effectivePrefix>-run-request`. */
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    await this.queue(this.#runRequestName()).add('runRequest', msg, {
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /** Control plane: consume run requests. Starts the consumer on first call (idempotent — a second
   *  call is a no-op). */
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    if (this.runRequestWorker) return;
    this.runRequestWorker = new Worker(
      this.#runRequestName(),
      (job) => handler(job.data as RunRequest),
      { connection: this.workerConnection() },
    );
  }

  /** Control plane → tenant worker: publish a correlated {@link RunReply} on the shared reply channel. */
  async publishRunReply(reply: RunReply): Promise<void> {
    if (!this.runReplyPub) this.runReplyPub = this.redis();
    await this.runReplyPub.publish(this.runReplyChannel(), JSON.stringify(reply));
  }

  /** Tenant worker ← control plane: consume {@link RunReply}s (filter by `requestId` client-side). */
  onRunReply(handler: (reply: RunReply) => void): void {
    if (this.runReplySub) return; // one subscription per transport
    this.runReplySub = this.subscriberRedis();
    void this.runReplySub.subscribe(this.runReplyChannel());
    this.runReplySub.on('message', (_channel, payload) => {
      try {
        handler(JSON.parse(payload) as RunReply);
      } catch {
        /* ignore malformed run replies */
      }
    });
  }

  /** Control plane → tenant worker: re-publish a lifecycle {@link TenantEvent} on the run's
   *  per-tenant channel. */
  async publishTenantEvent(evt: TenantEvent): Promise<void> {
    if (!this.tenantEventPub) this.tenantEventPub = this.redis();
    await this.tenantEventPub.publish(this.tenantEventChannel(evt.tenant), JSON.stringify(evt));
  }

  /** Tenant worker ← control plane: subscribe to THIS tenant's event channel, on its own connection
   *  (unlike control/heartbeat/runReply, several tenants — or several callers for the same tenant —
   *  may subscribe independently). Returns an unsubscribe fn that unsubscribes and disconnects. */
  onTenantEvent(tenant: string, handler: (evt: TenantEvent) => void): () => void {
    const channel = this.tenantEventChannel(tenant);
    const sub = this.subscriberRedis();
    this.tenantEventSubs.add(sub);
    void sub.subscribe(channel);
    sub.on('message', (_channel, payload) => {
      try {
        handler(JSON.parse(payload) as TenantEvent);
      } catch {
        /* ignore malformed tenant events */
      }
    });
    return () => {
      this.tenantEventSubs.delete(sub);
      this.subscribers.delete(sub);
      void sub.unsubscribe(channel);
      sub.disconnect();
    };
  }

  /** Close all workers and queues so the process can exit. */
  async close(): Promise<void> {
    if (this.workerHeartbeatTimer) clearInterval(this.workerHeartbeatTimer);
    if (this.pingWatchdogTimer) clearInterval(this.pingWatchdogTimer);
    this.subscribers.clear();
    this.workerController?.stop();
    await Promise.all([...this.taskWorkers.values()].map((w) => w.close()));
    await this.resultsWorker?.close();
    await this.decisionsWorker?.close();
    await this.stepEventsWorker?.close();
    await this.startRunWorker?.close();
    await this.runRequestWorker?.close();
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.controlPub?.disconnect();
    this.controlSub?.disconnect();
    this.heartbeatPub?.disconnect();
    this.heartbeatSub?.disconnect();
    this.runReplyPub?.disconnect();
    this.runReplySub?.disconnect();
    this.tenantEventPub?.disconnect();
    for (const sub of this.tenantEventSubs) sub.disconnect();
    this.tenantEventSubs.clear();
    this.workerHeartbeatRedis?.disconnect();
  }
}
