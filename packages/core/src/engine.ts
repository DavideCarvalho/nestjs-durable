import { backoffDelay } from './backoff';
import { instantCheckpoint } from './checkpoints';
import { type Completion } from './completion';
import { parseDuration } from './duration';
import { ContinueAsNew, NonDeterminismError, RemoteStepTimeout, WorkflowSuspended } from './errors';
import { eventMatchOf, eventMatches, eventPrefix } from './events';
import type {
  ControlPlane,
  EngineEvent,
  EngineListener,
  NamedTransport,
  RemoteStepDef,
  RemoteTask,
  RunDispatcher,
  RunResult,
  RunStatus,
  SearchAttributes,
  StateStore,
  StepError,
  StepEvent,
  StepInterceptor,
  StepInvocation,
  StepResult,
  Transport,
  UpdateResult,
  UpdateValidator,
  WorkflowCtx,
  WorkflowRun,
} from './interfaces';
import { breakpointToken, stepId } from './protocol';
import { type QueueConfig, QueueController } from './queue';
import { TransportPool } from './transport-pool';
import {
  type Compensation,
  type CtxHost,
  type StepRecord,
  createWorkflowCtx,
} from './workflow-ctx';
import {
  type WorkflowClass,
  type WorkflowInputOf,
  type WorkflowRef,
  workflowName,
} from './workflow-ref';

type WorkflowFn = (ctx: WorkflowCtx, input: unknown) => Promise<unknown>;

/** Options for {@link WorkflowEngine.start}. */
export interface StartOptions {
  /** Run-scoped tags, merged with the workflow's static `@Workflow({ tags })` onto the run. */
  tags?: string[];
  /** Typed, queryable run data stamped on the run (e.g. `{ amount: 200, tier: 'pro' }`). */
  searchAttributes?: SearchAttributes;
}

/**
 * Serialize runs of a workflow that share a key — a durable, FIFO mutex (e.g. one pipeline per base).
 * Excess runs are admitted in creation order, `limit` at a time; the rest wait (suspended) and retry
 * admission on a timer until a slot frees. Race-free on a consistent store (admission order is the
 * same `(createdAt, id)` view for every instance).
 */
export interface SingletonConfig {
  /** Derive the serialization key from the workflow input. */
  key: (input: unknown) => string;
  /** Max concurrent runs sharing the key. Default 1 (a mutex). */
  limit?: number;
}

/** How long a gated (waiting-for-admission) singleton run sleeps before re-checking for a free slot. */
const SINGLETON_RETRY_MS = 1000;

/** The tag a singleton run carries, so the admission gate can find others sharing its key. */
const singletonTag = (cfg: SingletonConfig, input: unknown): string =>
  `singleton:${cfg.key(input)}`;

/** Union of a workflow's static tags and a run's start-time tags, de-duplicated, or undefined if none. */
function mergeTags(staticTags?: string[], runTags?: string[]): string[] | undefined {
  if (!staticTags?.length && !runTags?.length) return undefined;
  return [...new Set([...(staticTags ?? []), ...(runTags ?? [])])];
}

/** A breakpoint checkpoint's `name` is `breakpoint` (or `breakpoint:<label>`). This name — not the
 *  reused `signal` kind — is the explicit marker the dashboard and `continue()` detect it by. */
const BREAKPOINT = 'breakpoint';
const isBreakpoint = (cp: { status: string; name: string }): boolean =>
  cp.status === 'pending' && cp.name.startsWith(BREAKPOINT);

interface RegisteredWorkflow {
  name: string;
  version: string;
  fn: WorkflowFn;
  /** Static `@Workflow({ tags })` — merged with per-run tags onto each run at start. */
  tags?: string[];
  /** Per-key serialization (a durable mutex). See {@link SingletonConfig}. */
  singleton?: SingletonConfig;
  /** Max wall-clock lifetime (ms) before a run is cancelled by `sweepTimeouts`. */
  executionTimeoutMs?: number;
  /** Validate the input at start; throw to reject before a run is created. Validator-agnostic. */
  validateInput?: (input: unknown) => void | Promise<void>;
  /** Event names that start a fresh run of this workflow when published. See `publishEvent`. */
  onEvent?: string[];
}

const versionKey = (name: string, version: string): string => `${name}@${version}`;

/** The id for the next continuation of a run: `r` → `r~1` → `r~2` … (stable, traceable lineage). */
function nextContinuationId(runId: string): string {
  const m = runId.match(/^(.*)~(\d+)$/);
  return m ? `${m[1]}~${Number(m[2]) + 1}` : `${runId}~1`;
}

/** True when version `a` is newer than `b` (numeric when both parse as numbers, else natural sort). */
function isNewerVersion(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na > nb;
  return a.localeCompare(b, undefined, { numeric: true }) > 0;
}

/** What a remote worker hands back: the output plus when it actually began (for queue-wait timing). */
interface RemoteResolution {
  output: unknown;
  startedAt?: number;
  events?: StepEvent[];
}

interface PendingRemote {
  resolve: (result: RemoteResolution) => void;
  reject: (error: Error) => void;
}

export interface WorkflowEngineDeps {
  store: StateStore;
  /** A single task transport. Shorthand for a one-entry `transports` pool (id `default`). */
  transport?: Transport;
  /**
   * An ordered pool of named transports. The engine dispatches on the first and fails over to the
   * next on a dispatch error; a step pins one via `ctx.call(step, input, { transport: id })`. Use
   * this instead of `transport` for failover / multi-broker setups.
   */
  transports?: NamedTransport[];
  /**
   * Cross-instance broadcast pub/sub for lifecycle events + cancellation (see {@link ControlPlane}).
   * Separate from the task `transport`; omit for a single-instance / local-only setup. A transport
   * that can also broadcast may be passed here as well.
   */
  controlPlane?: ControlPlane;
  /** Epoch-ms clock; injectable for tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** Unique id for this engine instance, used for recovery leases. Defaults to a random id. */
  instanceId?: string;
  /** Recovery lease duration in ms — how long this instance owns a run it picked up. Default 30s. */
  leaseMs?: number;
  /**
   * Cap how many times crash-recovery may pick up the same still-`running` run before giving up and
   * moving it to the `dead` dead-letter state (a poison pill that crashes the process every boot).
   * Omit for unlimited (the default — recovery always retries).
   */
  maxRecoveryAttempts?: number;
  /**
   * Build the public callback URL for a `ctx.webhook()` token (e.g.
   * ``(t) => `https://api.example.com/durable/webhooks/${t}` ``). Populates
   * {@link DurableWebhook.url}. Omit if you build URLs yourself from the token.
   */
  webhookUrl?: (token: string) => string;
  /**
   * Provide the current W3C `traceparent` to stamp on each dispatched {@link RemoteTask}, so a
   * worker (including the Python SDK) continues the distributed trace. Keep core OTel-free: supply
   * `otelTraceparent` from `@dudousxd/nestjs-durable-otel`, or your own context reader. Omit to send none.
   */
  traceparent?: () => string | undefined;
  /**
   * Attempts for each saga compensation when the run fails (a transient undo — e.g. a refund API
   * hiccup — gets another try). Default 1 (no retry). Compensations must be idempotent.
   */
  compensationRetries?: number;
  /**
   * Where a freshly-`start`ed run executes (see {@link RunDispatcher}). Defaults to in-process: the
   * run executes on this instance asynchronously (a microtask), so `start` returns without blocking.
   * Pass a no-op dispatcher on a caller that must NOT run workflows (e.g. an API/dashboard pod), and
   * run `runPending` on a worker pod to pick those up; or a broker-backed one for a worker pool.
   */
  runDispatcher?: RunDispatcher;
}

/**
 * The orchestrator. Owns workflow state and replays runs deterministically: each step's
 * result is checkpointed, so on resume a completed step returns its saved output instead of
 * re-executing. Remote steps are dispatched over the Transport; their results checkpoint the
 * same way local steps do.
 */
export class WorkflowEngine {
  private readonly store: StateStore;
  /** Ordered transport pool (dispatch + failover). Empty = no remote steps. */
  private readonly pool: TransportPool;
  private readonly controlPlane?: ControlPlane;
  private readonly clock: () => number;
  private readonly instanceId: string;
  private readonly leaseMs: number;
  private readonly maxRecoveryAttempts?: number;
  private readonly webhookUrl?: (token: string) => string;
  private readonly traceparent?: () => string | undefined;
  private readonly compensationRetries: number;
  /** Where a freshly-started run executes — in-process by default (see {@link RunDispatcher}). */
  private readonly runDispatcher: RunDispatcher;
  /** Every registered workflow, keyed by `name@version` — so old versions stay runnable. */
  private readonly workflows = new Map<string, RegisteredWorkflow>();
  /** The newest registered version per workflow name — used to `start` new runs. */
  private readonly latest = new Map<string, RegisteredWorkflow>();
  /** Event name → workflow names started when that event is published (see `onEvent`). */
  private readonly eventTriggers = new Map<string, Set<string>>();
  /** In-flight remote steps awaiting a worker result, keyed by stepId. */
  private readonly pending = new Map<string, PendingRemote>();
  /** Per-step "reset the liveness timer" callbacks, called when a heartbeat arrives. */
  private readonly heartbeatResets = new Map<string, () => void>();
  private readonly listeners = new Set<EngineListener>();
  /** Step interceptors (onion middleware around real local-step execution), first = outermost. */
  private readonly interceptors: StepInterceptor[] = [];
  /** Callbacks notified (on any instance) when a run is cancelled — for cooperative cancellation. */
  private readonly cancelListeners = new Set<(runId: string) => void>();
  /** Notified when a run is dead-lettered (moved to `dead`) — a hook for a DLQ handler. */
  private readonly deadListeners = new Set<(run: WorkflowRun) => void>();
  /** Validators gating `engine.update`, keyed by `<workflow>:<updateName>`. */
  private readonly updateValidators = new Map<string, UpdateValidator>();
  /** Runs being cancelled WITH saga compensation — see `cancel({ compensate: true })`. */
  private readonly cancelRequested = new Set<string>();
  /** Flow-control queues for remote steps, keyed by name (see {@link registerQueue}). */
  private readonly queues = new Map<string, QueueController>();
  /** Which queue a dispatched step took a slot from, by stepId — so the result can release it. */
  private readonly stepQueue = new Map<string, string>();
  /** Executions currently in flight, so a graceful shutdown can wait for them to settle. */
  private readonly inflight = new Set<Promise<RunResult>>();
  private draining = false;

  constructor(deps: WorkflowEngineDeps) {
    this.store = deps.store;
    this.pool = new TransportPool(
      deps.transports ?? (deps.transport ? [{ id: 'default', transport: deps.transport }] : []),
    );
    this.controlPlane = deps.controlPlane;
    this.clock = deps.clock ?? Date.now;
    this.instanceId = deps.instanceId ?? globalThis.crypto.randomUUID();
    this.leaseMs = deps.leaseMs ?? 30_000;
    this.maxRecoveryAttempts = deps.maxRecoveryAttempts;
    this.webhookUrl = deps.webhookUrl;
    this.traceparent = deps.traceparent;
    this.compensationRetries = Math.max(1, deps.compensationRetries ?? 1);
    // Default: execute the run on this instance, asynchronously, so `start` never blocks on the body.
    // A failed pickup is swallowed here (the run stays `pending` for a `runPending` poll to retry);
    // run failures themselves are handled inside `execute` and surfaced as the run's `failed` state.
    this.runDispatcher = deps.runDispatcher ?? {
      dispatch: (runId) => queueMicrotask(() => void this.runOne(runId).catch(() => {})),
    };
    this.pool.bind(
      async (result) => {
        // In-memory path (a `timeoutMs` step awaiting on THIS instance): resolve its pending promise.
        const waiter = this.pending.get(result.stepId);
        if (waiter) {
          this.pending.delete(result.stepId);
          if (result.status === 'completed') {
            waiter.resolve({
              output: result.output,
              startedAt: result.startedAt,
              events: result.events,
            });
          } else {
            waiter.reject(new RemoteStepError(result.error));
          }
          return;
        }
        // Durable path: no in-memory waiter (the step suspended the run, possibly on another
        // instance) → complete the checkpoint and resume the run here.
        await this.completeRemoteResult(result);
      },
      // A heartbeat for an in-flight long step resets its liveness window (see callRemote).
      async (beat) => {
        this.heartbeatResets.get(beat.stepId)?.();
      },
    );
    // Control plane: re-broadcast lifecycle events from OTHER instances to this instance's
    // subscribers (cross-pod live-tail), and act on cancellations issued elsewhere. A broker may
    // echo our own publish back — ignore those (we already handled them locally) to avoid duplicates.
    this.controlPlane?.onControl((msg) => {
      if (msg.from === this.instanceId) return;
      if (msg.kind === 'event') {
        // `at` may be a string after JSON transit (Redis) — normalize back to a Date.
        this.deliver({ ...msg.event, at: new Date(msg.event.at) });
      } else if (msg.kind === 'cancel') {
        this.notifyCancelled(msg.runId);
      }
    });
  }

  /** Fire cooperative-cancellation listeners for `runId` (a worker bridge aborts in-flight work). */
  private notifyCancelled(runId: string): void {
    for (const fn of this.cancelListeners) {
      try {
        fn(runId);
      } catch {
        /* a cancel listener must not break the engine */
      }
    }
  }

  /**
   * Register a workflow version. Register multiple versions of the same name to keep in-flight
   * runs working across a breaking change: old runs resume on the version they started on, new
   * runs start on the newest registered version.
   */
  register(
    name: string,
    version: string,
    fn: WorkflowFn,
    opts?: {
      tags?: string[];
      singleton?: SingletonConfig;
      executionTimeout?: string | number;
      validateInput?: (input: unknown) => void | Promise<void>;
      onEvent?: string[];
    },
  ): void {
    const registered: RegisteredWorkflow = {
      name,
      version,
      fn,
      tags: opts?.tags,
      singleton: opts?.singleton,
      executionTimeoutMs:
        opts?.executionTimeout != null ? parseDuration(opts.executionTimeout) : undefined,
      validateInput: opts?.validateInput,
      onEvent: opts?.onEvent,
    };
    this.workflows.set(versionKey(name, version), registered);
    const current = this.latest.get(name);
    if (!current || isNewerVersion(version, current.version)) this.latest.set(name, registered);
    for (const event of opts?.onEvent ?? []) {
      const subscribers = this.eventTriggers.get(event) ?? new Set<string>();
      subscribers.add(name);
      this.eventTriggers.set(event, subscribers);
    }
  }

  /**
   * Register a flow-control queue referenced by `ctx.call(step, input, { queue })`. Caps concurrent
   * in-flight steps and/or the admission rate; blocked calls re-suspend and retry, so the limit is
   * durable. Per engine instance (see {@link QueueConfig}). Registering the same name replaces it.
   */
  registerQueue(config: QueueConfig): void {
    this.queues.set(config.name, new QueueController(config, this.clock));
  }

  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Register a {@link StepInterceptor} — onion middleware run around the real execution of every
   * local `ctx.step` (timing, logging, tracing, error enrichment, context propagation). First
   * registered is outermost; interceptors fire only when a step executes, never on replay. Returns
   * an unsubscribe function.
   */
  use(interceptor: StepInterceptor): () => void {
    this.interceptors.push(interceptor);
    return () => {
      const i = this.interceptors.indexOf(interceptor);
      if (i >= 0) this.interceptors.splice(i, 1);
    };
  }

  /** Fold the registered interceptors around a local step body (identity when there are none). */
  private interceptStep<T>(invocation: StepInvocation, body: () => Promise<T>): Promise<T> {
    if (this.interceptors.length === 0) return body();
    const chain = this.interceptors.reduceRight<() => Promise<unknown>>(
      (next, interceptor) => () => interceptor(invocation, next),
      body as () => Promise<unknown>,
    );
    return chain() as Promise<T>;
  }

  /**
   * Be notified when a run is cancelled — on ANY instance, via the transport control plane. A
   * worker bridge can use this for cooperative cancellation: abort the in-flight work for `runId`
   * instead of finishing it just to have the result discarded. Returns an unsubscribe function.
   */
  onCancel(listener: (runId: string) => void): () => void {
    this.cancelListeners.add(listener);
    return () => this.cancelListeners.delete(listener);
  }

  /**
   * Be notified when a run is **dead-lettered** — moved to `dead` after exceeding
   * `maxRecoveryAttempts`. The listener receives the dead run (status `dead`, with its error), so a
   * DLQ handler can do something other than just leaving it parked: alert, push to a real queue, or
   * start a dead-letter workflow (e.g. `engine.onDead((run) => engine.start('pipeline-dlq', run, ...))`).
   * Returns an unsubscribe function.
   */
  onDead(listener: (run: WorkflowRun) => void): () => void {
    this.deadListeners.add(listener);
    return () => this.deadListeners.delete(listener);
  }

  private notifyDead(run: WorkflowRun): void {
    for (const fn of this.deadListeners) {
      try {
        fn(run);
      } catch {
        /* a dead-letter handler must not break recovery */
      }
    }
  }

  /** Emit a locally-produced lifecycle event: deliver to subscribers AND broadcast it on the
   *  control plane so other instances (e.g. a dashboard pod) can live-tail this run. */
  private emit(event: Omit<EngineEvent, 'at'>): void {
    const full: EngineEvent = { ...event, at: new Date() };
    this.deliver(full);
    if (this.controlPlane) {
      void this.controlPlane
        .publishControl({ kind: 'event', event: full, from: this.instanceId })
        .catch(() => {
          // control-plane delivery is best-effort observability; never break execution
        });
    }
  }

  /** Deliver an event to local subscribers only (no re-broadcast) — used for both locally-produced
   *  events and ones received from the control plane, so an event shows up once on every instance. */
  private deliver(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving subscriber must never break workflow execution
      }
    }
  }

  async start<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  async start<TInput>(
    workflow: string,
    input: TInput,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  async start(
    workflow: WorkflowRef,
    input: unknown,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult> {
    const name = workflowName(workflow);
    const registered = this.latest.get(name);
    if (!registered) throw new Error(`workflow ${name} is not registered`);
    // Validate the input up front — a bad payload is rejected before any run is created.
    await registered.validateInput?.(input);
    // Idempotent by run id: a redelivered trigger (at-least-once queues) or a scheduler re-tick for
    // the same id is a no-op, returning the existing run's state instead of starting a duplicate.
    const prior = await this.store.getRun(runId);
    if (prior) {
      return { runId, status: prior.status, output: prior.output, error: prior.error };
    }
    const now = new Date();
    // A singleton workflow stamps a `singleton:<key>` tag so the admission gate (in execute) can find
    // the other in-flight runs sharing the key via a tag+status query.
    const tags = mergeTags(
      registered.tags,
      registered.singleton
        ? [...(opts?.tags ?? []), singletonTag(registered.singleton, input)]
        : opts?.tags,
    );
    const run: WorkflowRun = {
      id: runId,
      workflow: name,
      workflowVersion: registered.version,
      status: 'pending',
      input,
      tags,
      searchAttributes: opts?.searchAttributes,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createRun(run);
    // The run is durably enqueued; a dispatcher (in-process by default) executes it — `start` does
    // NOT run the body inline. Await the terminal/suspended state with `waitForRun(runId)` if needed.
    await this.runDispatcher.dispatch(runId);
    return { runId, status: 'pending' };
  }

  /** Read a run's current persisted state (or null if unknown). A thin pass-through to the store. */
  getRun(runId: string): Promise<WorkflowRun | null> {
    return this.store.getRun(runId);
  }

  async resume(runId: string): Promise<RunResult> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    // A definitively-finished run must not be re-executed (e.g. a worker result landing after the
    // run was cancelled, or a duplicate resume) — that would replay the body and clobber the
    // terminal state. `failed` is intentionally NOT terminal here: retry resumes a failed run.
    if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'dead') {
      return { runId, status: run.status, output: run.output, error: run.error };
    }
    // Pin to the version the run STARTED on — replay is positional, so running a changed
    // workflow body against old checkpoints would corrupt the run.
    const registered = this.workflows.get(versionKey(run.workflow, run.workflowVersion));
    if (!registered) {
      throw new Error(
        `workflow ${run.workflow}@${run.workflowVersion} is not registered — keep the prior version deployed so in-flight runs can drain (skew protection)`,
      );
    }
    return this.track(this.execute(run, registered.fn));
  }

  /** Track an in-flight execution so {@link drain} can wait for it. */
  private track(p: Promise<RunResult>): Promise<RunResult> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  /**
   * Graceful shutdown: stop picking up new runs (recovery/timer become no-ops) and wait for
   * in-flight executions to settle, up to `timeoutMs`. Call from your app's shutdown hook so a
   * deploy hands off cleanly instead of leaving runs to the lease timeout.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    this.draining = true;
    if (this.inflight.size === 0) return;
    const timer = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      (t as { unref?: () => void }).unref?.();
    });
    await Promise.race([Promise.allSettled([...this.inflight]), timer]);
  }

  /**
   * Cancel in-flight runs that have outlived their workflow's `executionTimeout`. Call it from the
   * timer poller alongside {@link resumeDueTimers}. A timed-out run is moved to `cancelled` with an
   * `execution_timeout` error (terminal, so a late step result can't resurrect it).
   */
  async sweepTimeouts(now: number = this.clock()): Promise<void> {
    for (const reg of new Set(this.latest.values())) {
      if (reg.executionTimeoutMs == null) continue;
      const deadline = now - reg.executionTimeoutMs;
      const inflight = [
        ...(await this.store.listRuns({ workflow: reg.name, status: 'running' })),
        ...(await this.store.listRuns({ workflow: reg.name, status: 'suspended' })),
      ];
      for (const run of inflight) {
        if (run.createdAt.getTime() > deadline) continue;
        const error = { message: 'execution timeout', code: 'execution_timeout' };
        await this.store.updateRun(run.id, { status: 'cancelled', error, updatedAt: new Date() });
        this.emit({ type: 'run.failed', runId: run.id, workflow: run.workflow, error });
      }
    }
  }

  /**
   * Resume every run left incomplete by a crash or deploy. Called on boot. Completed steps
   * replay from their checkpoints, so only the work that had not finished runs again.
   */
  async recoverIncomplete(nowMs: number = this.clock()): Promise<RunResult[]> {
    return this.resumeLeased(await this.store.listIncompleteRuns(), nowMs, (run) =>
      this.countRecovery(run),
    );
  }

  /**
   * Per-recovery bookkeeping (called once the lease is held): count the attempt, or — past
   * `maxRecoveryAttempts` — move a poison pill to the `dead` dead-letter state. Returns a terminal
   * result to skip the resume, or `undefined` to proceed.
   */
  private async countRecovery(run: WorkflowRun): Promise<RunResult | undefined> {
    const attempts = (run.recoveryAttempts ?? 0) + 1;
    if (this.maxRecoveryAttempts != null && attempts > this.maxRecoveryAttempts) {
      const error = {
        message: `run exceeded maxRecoveryAttempts (${this.maxRecoveryAttempts}) — moved to dead-letter`,
        code: 'max_recovery_attempts',
      };
      await this.store.updateRun(run.id, { status: 'dead', error, updatedAt: new Date() });
      await this.store.releaseRunLock(run.id);
      this.emit({ type: 'run.failed', runId: run.id, workflow: run.workflow, error });
      this.notifyDead({ ...run, status: 'dead', error, recoveryAttempts: attempts });
      return { runId: run.id, status: 'dead', error };
    }
    // Count BEFORE resuming, so a crash mid-resume still advances the counter.
    await this.store.updateRun(run.id, { recoveryAttempts: attempts, updatedAt: new Date() });
    return undefined;
  }

  /**
   * Resume every suspended run whose durable timer is due. Call periodically (a poller) and on
   * boot. A run still not due re-suspends cheaply without running new work.
   */
  async resumeDueTimers(nowMs: number = this.clock()): Promise<RunResult[]> {
    return this.resumeLeased(await this.store.listDueTimers(nowMs), nowMs);
  }

  /**
   * Lease and execute one run by id — the worker side of dispatch. Acquires the recovery lease (so
   * exactly one instance runs it), then resumes the body. Returns the result, or null if another
   * instance holds the lease or the engine is draining. The default in-process dispatcher calls this;
   * a broker-backed worker calls it per consumed run id.
   */
  async runOne(runId: string): Promise<RunResult | null> {
    if (this.draining) return null;
    const nowMs = this.clock();
    const acquired = await this.store.tryLockRun(
      runId,
      this.instanceId,
      nowMs + this.leaseMs,
      nowMs,
    );
    if (!acquired) return null;
    return this.resume(runId);
  }

  /**
   * Pick up and execute every `pending` run — the poll-based side of dispatch for a worker pod with
   * no broker. Runs enqueued by other pods (or by a caller using a no-op dispatcher) sit `pending`
   * in the store until polled; leasing ensures exactly one pod runs each. Call periodically alongside
   * {@link resumeDueTimers}.
   */
  async runPending(nowMs: number = this.clock()): Promise<RunResult[]> {
    return this.resumeLeased(await this.store.listRuns({ status: 'pending', limit: 100 }), nowMs);
  }

  /**
   * Resolve once `runId` reaches a settled state — terminal (completed/failed/cancelled/dead) or
   * suspended (handed off to a timer/signal/event). The async counterpart to dispatch: pair it with
   * `start` when a call site needs the outcome — `await start(...); const r = await waitForRun(id)`.
   */
  waitForRun(runId: string, opts?: { timeoutMs?: number }): Promise<RunResult> {
    const isSettled = (s: RunStatus): boolean => s !== 'pending' && s !== 'running';
    const toResult = (run: WorkflowRun): RunResult => ({
      runId,
      status: run.status,
      output: run.output,
      error: run.error,
    });
    return new Promise<RunResult>((resolve, reject) => {
      let done = false;
      let off: () => void = () => {};
      const timer =
        opts?.timeoutMs != null
          ? setTimeout(() => {
              if (done) return;
              done = true;
              off();
              reject(new Error(`waitForRun(${runId}) timed out after ${opts.timeoutMs}ms`));
            }, opts.timeoutMs)
          : undefined;
      const finish = (run: WorkflowRun): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        off();
        resolve(toResult(run));
      };
      const check = (): void => {
        void this.store.getRun(runId).then((run) => {
          if (run && isSettled(run.status)) finish(run);
        });
      };
      // Subscribe BEFORE the initial read so a run that settles in between isn't missed.
      off = this.subscribe((ev) => {
        if (ev.runId === runId) check();
      });
      check();
    });
  }

  /**
   * Resume each run only if this instance can acquire its recovery lease — so when several
   * replicas recover or poll at once, each run is picked up by exactly one of them.
   */
  private async resumeLeased(
    runs: WorkflowRun[],
    nowMs: number = this.clock(),
    onLocked?: (run: WorkflowRun) => Promise<RunResult | undefined>,
  ): Promise<RunResult[]> {
    if (this.draining) return []; // shutting down — don't pick up new runs
    const results: RunResult[] = [];
    for (const run of runs) {
      const acquired = await this.store.tryLockRun(
        run.id,
        this.instanceId,
        nowMs + this.leaseMs,
        nowMs,
      );
      if (!acquired) continue;
      // A per-run hook (recovery counting / dead-lettering) may settle the run terminally instead.
      const settled = onLocked ? await onLocked(run) : undefined;
      results.push(settled ?? (await this.resume(run.id)));
    }
    return results;
  }

  /**
   * Deliver an external signal to the run waiting on `token` and resume it with `payload`.
   * Returns the run result, or null if no run is waiting for that token.
   */
  /**
   * Publish a named event. It does two things, and returns how many runs it touched (the sum):
   *  1. **Resumes** every in-flight run waiting on it via `ctx.waitForEvent(name, { match })` whose
   *     match the payload satisfies (fan-out, vs `signal`'s point-to-point token).
   *  2. **Starts** a fresh run of every workflow registered with `onEvent: [name]`, passing the
   *     payload as input. Idempotent by `evt:<id>:<workflow>` — pass `opts.id` to dedupe redeliveries
   *     of the same logical event (default: a fresh uuid, so each publish triggers once).
   */
  async publishEvent(name: string, payload: unknown, opts?: { id?: string }): Promise<number> {
    let touched = 0;
    const waiters = await this.store.listSignalWaiters(eventPrefix(name));
    for (const w of waiters) {
      if (eventMatches(payload, eventMatchOf(w.token))) {
        await this.signal(w.token, payload);
        touched += 1;
      }
    }
    const subscribers = this.eventTriggers.get(name);
    if (subscribers?.size) {
      const eventId = opts?.id ?? globalThis.crypto.randomUUID();
      for (const workflow of subscribers) {
        // A subscriber that rejects the payload (validateInput) must not block the others or the
        // waiters — its run simply never starts, mirroring fire-and-forget dead-letter routing.
        try {
          await this.start(workflow, payload, `evt:${eventId}:${workflow}`);
          touched += 1;
        } catch {
          // skip this subscriber
        }
      }
    }
    return touched;
  }

  async signal(token: string, payload: unknown): Promise<RunResult | null> {
    const waiter = await this.store.takeSignalWaiter(token);
    if (!waiter) return null;
    await this.store.saveCheckpoint(
      instantCheckpoint({
        runId: waiter.runId,
        seq: waiter.seq,
        name: `signal:${token}`,
        kind: 'signal',
        output: payload,
      }),
    );
    return this.resume(waiter.runId);
  }

  /**
   * Report the result of a `ctx.task(name, …)` back to its run (async completion). The external
   * worker that the task dispatched to calls this when done; the run resumes with `result`. Returns
   * null if no run is waiting on the task (e.g. a duplicate/late delivery) — a safe no-op.
   */
  async completeTask(runId: string, name: string, result: unknown): Promise<RunResult | null> {
    return this.signal(`task:${runId}:${name}`, {
      ok: true,
      value: result,
    } satisfies Completion<unknown>);
  }

  /** Report that a `ctx.task` failed — the run resumes and throws a FatalError at the task. */
  async failTask(runId: string, name: string, error: string): Promise<RunResult | null> {
    return this.signal(`task:${runId}:${name}`, { ok: false, error } satisfies Completion<never>);
  }

  /**
   * Notify a parent that's waiting on `runId` as a child of its terminal outcome (the `ctx.child`
   * rendezvous). A no-op when no parent is waiting, so `execute()` can call it on every run without
   * knowing about the child feature.
   */
  private notifyParent(runId: string, completion: Completion<unknown>): void {
    void this.signal(`child:${runId}`, completion).catch(() => undefined);
  }

  /**
   * Cancel a run (e.g. from the dashboard). Returns null if the run does not exist. Pass
   * `{ compensate: true }` to undo the saga first: the suspended run is resumed so its completed
   * steps' compensations run in reverse (visible as `compensate:<step>` events), then it's marked
   * cancelled. Without it, cancellation is immediate (no undo).
   */
  async cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    // Compensating cancel: resume the run with a cancellation pending. Replay re-registers the
    // saga, and at the run's suspension point execute() runs the undo and marks it cancelled.
    if (opts?.compensate && (run.status === 'suspended' || run.status === 'running')) {
      this.cancelRequested.add(runId);
      const result = await this.resume(runId);
      this.notifyCancelled(runId);
      if (this.controlPlane) {
        void this.controlPlane
          .publishControl({ kind: 'cancel', runId, from: this.instanceId })
          .catch(() => undefined);
      }
      return result;
    }
    const error = { message: 'cancelled' };
    await this.store.updateRun(runId, { status: 'cancelled', error, updatedAt: new Date() });
    this.emit({ type: 'run.failed', runId, workflow: run.workflow, error });
    // Notify local cancel listeners now (a worker on this pod), and broadcast so the instance/worker
    // actually running this run learns of it and can abort cooperatively (the store already records
    // `cancelled`, but a busy worker won't re-read it).
    this.notifyCancelled(runId);
    if (this.controlPlane) {
      void this.controlPlane
        .publishControl({ kind: 'cancel', runId, from: this.instanceId })
        .catch(() => undefined);
    }
    return { runId, status: 'cancelled', error };
  }

  /** Checkpoint a finished step and announce it — the two things that must always happen together. */
  private async completeStep(step: StepRecord & { output: unknown }): Promise<void> {
    await this.store.saveCheckpoint({
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      stepId: stepId(step.runId, step.seq),
      status: 'completed',
      input: step.input,
      output: step.output,
      events: step.events && step.events.length > 0 ? step.events : undefined,
      attempts: step.attempts,
      workerGroup: step.workerGroup,
      enqueuedAt: step.enqueuedAt,
      startedAt: step.startedAt,
      finishedAt: new Date(),
    });
    this.emit({
      type: 'step.completed',
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      output: step.output,
      queueMs: step.startedAt.getTime() - step.enqueuedAt.getTime(),
      durationMs: Date.now() - step.startedAt.getTime(),
    });
  }

  /** Checkpoint a step that failed terminally, so the failure point is visible (not just the run). */
  private async failStep(step: StepRecord & { error: StepError }): Promise<void> {
    await this.store.saveCheckpoint({
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      stepId: stepId(step.runId, step.seq),
      status: 'failed',
      input: step.input,
      error: step.error,
      events: step.events && step.events.length > 0 ? step.events : undefined,
      attempts: step.attempts,
      workerGroup: step.workerGroup,
      enqueuedAt: step.enqueuedAt,
      startedAt: step.startedAt,
      finishedAt: new Date(),
    });
    this.emit({
      type: 'step.failed',
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      error: step.error,
      queueMs: step.startedAt.getTime() - step.enqueuedAt.getTime(),
      durationMs: Date.now() - step.startedAt.getTime(),
    });
  }

  /**
   * Whether `run` may run now under its singleton key: it's among the `limit` oldest in-flight runs
   * (running or suspended) sharing the key, by `(createdAt, id)` order. A consistent store gives every
   * instance the same ordering, so admission is race-free + FIFO.
   */
  private async admitSingleton(run: WorkflowRun, cfg: SingletonConfig): Promise<boolean> {
    const tag = singletonTag(cfg, run.input);
    const inflight = [
      ...(await this.store.listRuns({ tag, workflow: run.workflow, status: 'running' })),
      ...(await this.store.listRuns({ tag, workflow: run.workflow, status: 'suspended' })),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const idx = inflight.findIndex((r) => r.id === run.id);
    return idx >= 0 && idx < (cfg.limit ?? 1);
  }

  private async execute(run: WorkflowRun, fn: WorkflowFn): Promise<RunResult> {
    // Singleton admission gate: if this run shares its key with `limit` older in-flight runs, wait
    // (suspend on a short timer) until a slot frees instead of running now. Re-checked on each resume.
    const registered = this.workflows.get(versionKey(run.workflow, run.workflowVersion));
    if (registered?.singleton && !(await this.admitSingleton(run, registered.singleton))) {
      const wakeAt = this.clock() + SINGLETON_RETRY_MS;
      await this.store.updateRun(run.id, { status: 'suspended', wakeAt, updatedAt: new Date() });
      this.emit({ type: 'run.suspended', runId: run.id, workflow: run.workflow });
      await this.store.releaseRunLock(run.id);
      return { runId: run.id, status: 'suspended' };
    }
    // First execution of an enqueued run: mark it running and announce the start (a resumed run is
    // already past `pending`, so this fires exactly once, when the body actually begins).
    if (run.status === 'pending') {
      await this.store.updateRun(run.id, { status: 'running', updatedAt: new Date() });
      run.status = 'running';
      this.emit({ type: 'run.started', runId: run.id, workflow: run.workflow });
    }
    // Saga compensations registered by completed steps; run in reverse if the run later fails.
    const compensations: Compensation[] = [];
    const ctx = createWorkflowCtx(this.ctxHost, run.id, compensations, run.workflow);
    try {
      const output = await fn(ctx, run.input);
      // Clear any error from an earlier failed-then-retried attempt: a completed run is a success
      // and must not carry a stale error (otherwise dashboards show a green run with a red error).
      await this.store.updateRun(run.id, {
        status: 'completed',
        output,
        error: undefined,
        updatedAt: new Date(),
      });
      this.emit({ type: 'run.completed', runId: run.id, workflow: run.workflow, output });
      // Wake a parent waiting on this run as a child (no-op when there's no parent).
      void this.notifyParent(run.id, { ok: true, value: output });
      return { runId: run.id, status: 'completed', output };
    } catch (err) {
      if (err instanceof ContinueAsNew) {
        // Hand off to a fresh execution with a clean history: complete this run, then start the next
        // (`<id>~N`) with the new input. Deferred + idempotent by the continuation id, so a crash
        // mid-handoff re-derives the same next run instead of forking.
        await this.store.updateRun(run.id, {
          status: 'completed',
          output: undefined,
          error: undefined,
          updatedAt: new Date(),
        });
        this.emit({ type: 'run.completed', runId: run.id, workflow: run.workflow });
        void this.notifyParent(run.id, { ok: true, value: undefined });
        const nextId = nextContinuationId(run.id);
        queueMicrotask(
          () => void this.start(run.workflow, err.input, nextId).catch(() => undefined),
        );
        return { runId: run.id, status: 'completed' };
      }
      if (err instanceof WorkflowSuspended) {
        // A compensating cancel resumed this run to reach here: the replay re-registered the saga,
        // so undo the completed steps in reverse and mark it cancelled instead of re-suspending.
        if (this.cancelRequested.has(run.id)) {
          this.cancelRequested.delete(run.id);
          for (let i = compensations.length - 1; i >= 0; i -= 1) {
            const comp = compensations[i];
            if (comp) await this.runCompensation(run, comp);
          }
          const error = { message: 'cancelled' };
          await this.store.updateRun(run.id, { status: 'cancelled', error, updatedAt: new Date() });
          this.emit({ type: 'run.failed', runId: run.id, workflow: run.workflow, error });
          return { runId: run.id, status: 'cancelled', error };
        }
        await this.store.updateRun(run.id, {
          status: 'suspended',
          wakeAt: err.wakeAt,
          updatedAt: new Date(),
        });
        this.emit({ type: 'run.suspended', runId: run.id, workflow: run.workflow });
        return { runId: run.id, status: 'suspended' };
      }
      const error = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
      // Saga: undo completed steps in reverse, each retried up to `compensationRetries`. Outcomes
      // are emitted as `compensate:<step>` step events so a stranded undo is VISIBLE (not silently
      // swallowed) in the dashboard/telescope; a failing one is still skipped so it can't mask the
      // original failure or strand the rest. (Compensations should be idempotent.)
      for (let i = compensations.length - 1; i >= 0; i -= 1) {
        const comp = compensations[i];
        if (!comp) continue;
        await this.runCompensation(run, comp);
      }
      await this.store.updateRun(run.id, { status: 'failed', error, updatedAt: new Date() });
      this.emit({ type: 'run.failed', runId: run.id, workflow: run.workflow, error });
      void this.notifyParent(run.id, { ok: false, error: error.message });
      return { runId: run.id, status: 'failed', error };
    } finally {
      // Release the recovery lease once the run reaches a terminal/suspended state, so the
      // next instance (or the timer poller) can pick it up promptly.
      await this.store.releaseRunLock(run.id);
    }
  }

  /**
   * Run one saga compensation, retried up to `compensationRetries`, emitting a `compensate:<step>`
   * step event for its outcome so a stranded undo is visible. Never throws — a permanently-failing
   * compensation is skipped so it can't mask the original failure.
   */
  private async runCompensation(run: WorkflowRun, comp: Compensation): Promise<void> {
    const name = `compensate:${comp.name}`;
    for (let attempt = 1; attempt <= this.compensationRetries; attempt += 1) {
      const startedAt = Date.now();
      try {
        await comp.fn();
        this.emit({
          type: 'step.completed',
          runId: run.id,
          workflow: run.workflow,
          name,
          kind: 'local',
          durationMs: Date.now() - startedAt,
        });
        return;
      } catch (err) {
        if (attempt >= this.compensationRetries) {
          this.emit({
            type: 'step.failed',
            runId: run.id,
            workflow: run.workflow,
            name,
            kind: 'local',
            error: { message: err instanceof Error ? err.message : String(err) },
            durationMs: Date.now() - startedAt,
          });
        }
      }
    }
  }

  /** The seam handed to {@link createWorkflowCtx}: the authoring API reaches durability + lifecycle
   *  (checkpointing, dispatch, child start) through this, so the ctx primitives live in their own
   *  module and the engine stays the orchestrator. */
  private get ctxHost(): CtxHost {
    return {
      store: this.store,
      clock: this.clock,
      webhookUrl: this.webhookUrl,
      completeStep: (s) => this.completeStep(s),
      failStep: (s) => this.failStep(s),
      callRemote: (runId, seq, step, input, queue, transport) =>
        this.callRemote(runId, seq, step, input, queue, transport),
      // Defer so a fast child can't reentrantly resume a still-running parent.
      startChild: (workflow, input, id) => {
        queueMicrotask(() => void this.start(workflow, input, id).catch(() => undefined));
      },
      interceptStep: (invocation, body) => this.interceptStep(invocation, body),
    };
  }

  /**
   * Resume a run paused at a {@link WorkflowCtx.breakpoint} (e.g. the dashboard "continue" button).
   * Finds the run's pending breakpoint checkpoint and signals it. Returns null if the run isn't
   * paused at a breakpoint.
   */
  async continue(runId: string): Promise<RunResult | null> {
    const checkpoints = await this.store.listCheckpoints(runId);
    const bp = checkpoints.find(isBreakpoint);
    if (!bp) return null;
    return this.signal(breakpointToken(runId, bp.seq), undefined);
  }

  /**
   * Read the latest value a run published for `key` via {@link WorkflowCtx.setEvent} — a
   * side-effect-free query of a live (or finished) run's state. Returns `undefined` if the run
   * never published that key. The suspend-model counterpart of a Temporal query.
   */
  async getEvent<TValue = unknown>(runId: string, key: string): Promise<TValue | undefined> {
    const name = `event:${key}`;
    const checkpoints = await this.store.listCheckpoints(runId);
    // listCheckpoints is ordered by seq ascending, so the last match is the most recent value.
    let latest: TValue | undefined;
    for (const cp of checkpoints) if (cp.name === name) latest = cp.output as TValue;
    return latest;
  }

  /**
   * Register a validator gating `engine.update(runId, name, …)` for runs of `workflow`. The
   * validator runs BEFORE the update is delivered, so a rejection leaves the run untouched. One
   * validator per (workflow, update name); registering again replaces it.
   */
  registerUpdateValidator<TArg>(
    workflow: string,
    name: string,
    validate: UpdateValidator<TArg>,
  ): void {
    this.updateValidators.set(`${workflow}:${name}`, validate as UpdateValidator);
  }

  /**
   * Deliver a validated update to the run waiting at `ctx.onUpdate(name)`. Runs the registered
   * validator (if any) first: on rejection returns `{ accepted: false, reason }` without disturbing
   * the run; otherwise delivers `arg` and resumes, returning `{ accepted: true, run }` (`run` is null
   * if nothing was waiting — a too-early or duplicate update).
   */
  async update(runId: string, name: string, arg: unknown): Promise<UpdateResult> {
    const run = await this.store.getRun(runId);
    if (!run) return { accepted: false, reason: `run ${runId} not found` };
    const validate = this.updateValidators.get(`${run.workflow}:${name}`);
    if (validate) {
      try {
        const reason = await validate(arg);
        if (typeof reason === 'string' && reason.length > 0) return { accepted: false, reason };
      } catch (err) {
        return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    const result = await this.signal(`update:${runId}:${name}`, arg);
    return { accepted: true, run: result };
  }

  private async callRemote<TInput, TOutput>(
    runId: string,
    seq: number,
    step: RemoteStepDef<TInput, TOutput>,
    input: TInput,
    queue?: string,
    transport?: string,
  ): Promise<TOutput> {
    const existing = await this.store.getCheckpoint(runId, seq);
    if (existing && existing.name !== step.name) {
      throw new NonDeterminismError(runId, seq, step.name, existing.name);
    }
    if (existing?.status === 'completed') return existing.output as TOutput;
    if (this.pool.size === 0) throw new Error('remote steps require a Transport');
    // A step with a liveness `timeoutMs` keeps the in-memory await + heartbeat path (re-dispatch a
    // presumed-dead worker). Without one, the call SUSPENDS DURABLY: dispatch, persist a `pending`
    // checkpoint, and let the result resume the run on whichever instance receives it — so a worker
    // pod can scale down or crash mid-step without losing the run or re-running completed work.
    if (step.timeoutMs) return this.callRemoteInMemory(runId, seq, step, input, transport);
    if (existing?.status === 'pending') throw new WorkflowSuspended(); // dispatched; keep waiting

    // Durable retry: a failed attempt re-dispatches up to `retries`, spacing attempts by `backoff` —
    // unless the worker marked the error non-retryable (a deterministic verdict like a declined card).
    // The retry deadline is stamped on the failed checkpoint as `wakeAt` (clock-space, persisted) the
    // first time we see it, so it's stable across replays and survives a crash.
    let attempt = 1;
    if (existing?.status === 'failed') {
      const maxAttempts = Math.max(1, step.retries ?? 1);
      const retryable = existing.error?.retryable !== false;
      if (!retryable || existing.attempts >= maxAttempts) throw new RemoteStepError(existing.error);
      if (existing.wakeAt == null) {
        const wakeAt = this.clock() + backoffDelay(existing.attempts, step);
        await this.store.saveCheckpoint({ ...existing, wakeAt });
        throw new WorkflowSuspended(wakeAt);
      }
      if (this.clock() < existing.wakeAt) throw new WorkflowSuspended(existing.wakeAt);
      attempt = existing.attempts + 1;
    }

    const id = stepId(runId, seq);
    // Flow control: a queued call that can't be admitted (concurrency/rate) does NOT dispatch — the
    // run re-suspends with the queue's retry time and the timer poller re-tries admission later, so
    // the limit is durable. The admitted slot is released when the result lands (completeRemoteResult).
    const controller = queue ? this.queues.get(queue) : undefined;
    if (controller) {
      const admission = controller.tryAdmit();
      if (!admission.ok) throw new WorkflowSuspended(admission.retryAt);
      this.stepQueue.set(id, queue as string);
    }

    const validInput = step.input.parse(input);
    const enqueuedAt = new Date();
    // Persist the pending checkpoint BEFORE dispatching, so a fast result always finds it to complete.
    await this.store.saveCheckpoint({
      runId,
      seq,
      name: step.name,
      kind: 'remote',
      stepId: id,
      status: 'pending',
      input: validInput,
      attempts: attempt,
      workerGroup: step.group,
      enqueuedAt,
      startedAt: enqueuedAt, // placeholders until the worker result lands
      finishedAt: enqueuedAt,
    });
    await this.pool.dispatch(
      {
        runId,
        seq,
        name: step.name,
        stepId: id,
        group: step.group,
        input: validInput,
        traceparent: this.traceparent?.(),
        attempt,
      },
      transport,
    );
    this.emit({ type: 'step.started', runId, seq, name: step.name, kind: 'remote' });
    throw new WorkflowSuspended();
  }

  /**
   * Complete a durable remote step from its worker result and resume the run — runs on whichever
   * instance receives the result (the dispatching one may be gone), so the run is crash/scale-safe.
   * A no-op if the checkpoint isn't `pending` (a duplicate or late delivery).
   */
  private async completeRemoteResult(result: StepResult): Promise<void> {
    const cp = await this.store.getCheckpoint(result.runId, result.seq);
    if (!cp || cp.status !== 'pending') return;
    // A result settling this step frees its flow-control slot (no-op if it wasn't queued). Done
    // before the cancelled-run early-return below, so a cancellation can't leak the slot.
    this.releaseQueueSlot(cp.stepId);
    // Drop a late result for a run that was cancelled/finished meanwhile — don't complete the step
    // or resume (the run is already terminal). This is the engine side of cooperative cancellation.
    const run = await this.store.getRun(result.runId);
    if (run && (run.status === 'cancelled' || run.status === 'completed')) return;
    const finishedAt = new Date();
    const startedAt = result.startedAt ? new Date(result.startedAt) : cp.startedAt;
    await this.store.saveCheckpoint({
      ...cp,
      status: result.status,
      output: result.status === 'completed' ? result.output : cp.output,
      error: result.error,
      events: result.events ?? cp.events,
      startedAt,
      finishedAt,
    });
    this.emit({
      type: result.status === 'completed' ? 'step.completed' : 'step.failed',
      runId: result.runId,
      seq: result.seq,
      name: cp.name,
      kind: cp.kind,
      output: result.output,
      error: result.error,
      queueMs: startedAt.getTime() - cp.enqueuedAt.getTime(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
    await this.resume(result.runId);
  }

  /** Release the flow-control slot a dispatched step held (if any), by its stepId. */
  private releaseQueueSlot(id: string): void {
    const queue = this.stepQueue.get(id);
    if (queue === undefined) return;
    this.stepQueue.delete(id);
    this.queues.get(queue)?.release();
  }

  /** In-memory await path for a remote step with a liveness `timeoutMs` (re-dispatch on timeout). */
  private async callRemoteInMemory<TInput, TOutput>(
    runId: string,
    seq: number,
    step: RemoteStepDef<TInput, TOutput>,
    input: TInput,
    transport?: string,
  ): Promise<TOutput> {
    if (this.pool.size === 0) throw new Error('remote steps require a Transport');
    const validInput = step.input.parse(input);
    const id = stepId(runId, seq);
    const enqueuedAt = new Date();
    this.emit({ type: 'step.started', runId, seq, name: step.name, kind: 'remote' });
    // Retry policy differs from a LOCAL step on purpose: a local `ctx.step` retries any non-fatal
    // throw (the work is in-process), but a remote step only re-dispatches on a liveness TIMEOUT
    // (presumed-dead worker). A worker that *reported* an error returned a deterministic verdict, so
    // we surface it to the workflow instead of hammering the worker. Timeout retries need a window
    // to detect death, so they're gated on `timeoutMs` being set.
    const maxAttempts = step.timeoutMs ? Math.max(1, step.retries ?? 1) : 1;

    for (let attempt = 1; ; attempt += 1) {
      const resultPromise = new Promise<RemoteResolution>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
      });
      await this.pool.dispatch(
        {
          runId,
          seq,
          name: step.name,
          stepId: id,
          group: step.group,
          input: validInput,
          traceparent: this.traceparent?.(),
          attempt,
        },
        transport,
      );
      try {
        const resolution = step.timeoutMs
          ? await this.awaitWithHeartbeat(id, resultPromise, step.timeoutMs)
          : await resultPromise;
        const output = step.output.parse(resolution.output) as TOutput;
        // The worker reports when it actually picked the task up; fall back to dispatch time if a
        // transport doesn't carry it (queue-wait then reads as zero rather than going negative).
        const startedAt = resolution.startedAt ? new Date(resolution.startedAt) : enqueuedAt;
        await this.completeStep({
          runId,
          seq,
          name: step.name,
          kind: 'remote',
          input: validInput,
          output,
          events: resolution.events,
          attempts: attempt,
          workerGroup: step.group,
          enqueuedAt,
          startedAt,
        });
        return output;
      } catch (err) {
        this.pending.delete(id);
        if (err instanceof RemoteStepTimeout && attempt < maxAttempts) continue;
        throw err;
      }
    }
  }

  /**
   * Await a remote result, but reject with `RemoteStepTimeout` if neither the result nor a heartbeat
   * arrives within `timeoutMs`. Each heartbeat (delivered via `transport.onHeartbeat`) rearms the
   * window, so a worker that keeps beating stays alive past `timeoutMs`.
   */
  private awaitWithHeartbeat(
    id: string,
    resultPromise: Promise<RemoteResolution>,
    timeoutMs: number,
  ): Promise<RemoteResolution> {
    return new Promise<RemoteResolution>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        this.heartbeatResets.delete(id);
      };
      const arm = () => {
        timer = setTimeout(() => {
          cleanup();
          this.pending.delete(id);
          reject(new RemoteStepTimeout(id, timeoutMs));
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      };
      this.heartbeatResets.set(id, () => {
        clearTimeout(timer);
        arm();
      });
      arm();
      resultPromise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (err) => {
          cleanup();
          reject(err);
        },
      );
    });
  }
}

/** Raised inside the workflow when a remote worker reports a step failure. */
export class RemoteStepError extends Error {
  readonly stepError?: StepError;
  constructor(stepError?: StepError) {
    super(stepError?.message ?? 'remote step failed');
    this.name = 'RemoteStepError';
    this.stepError = stepError;
  }
}
