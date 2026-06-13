import { parseDuration } from './duration';
import {
  FatalError,
  NonDeterminismError,
  RemoteStepTimeout,
  SignalTimeoutError,
  WorkflowSuspended,
} from './errors';
import type {
  ControlPlane,
  DurableWebhook,
  EngineEvent,
  EngineListener,
  NamedTransport,
  RemoteStepDef,
  RemoteTask,
  RunResult,
  StateStore,
  StepError,
  StepEvent,
  StepKind,
  StepLogger,
  StepOptions,
  StepResult,
  Transport,
  UpdateResult,
  UpdateValidator,
  WorkflowCtx,
  WorkflowRun,
} from './interfaces';
import { stepId } from './protocol';
import { type QueueConfig, QueueController } from './queue';
import { createStepLogger } from './step-logger';

type WorkflowFn = (ctx: WorkflowCtx, input: unknown) => Promise<unknown>;

/** Deterministic signal token a breakpoint suspends on — derived from its logical position. */
const breakpointToken = (runId: string, seq: number): string => `bp:${runId}:${seq}`;

/** Delay in ms before the next retry of a local step, per its `StepOptions` backoff config. */
function backoffDelay(attempt: number, options?: StepOptions): number {
  const base = options?.backoffMs ?? 0;
  if (base <= 0) return 0;
  const raw = options?.backoff === 'exp' ? base * 2 ** (attempt - 1) : base;
  const capped = options?.backoffMaxMs ? Math.min(raw, options.backoffMaxMs) : raw;
  return options?.jitter ? Math.round(capped * (0.5 + Math.random() * 0.5)) : capped;
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
}

const versionKey = (name: string, version: string): string => `${name}@${version}`;

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

/**
 * The payload an external `ctx.task` / child run delivers back on its completion signal: either a
 * value or a failure. One typed envelope so `task` and `child` share the same unwrap (instead of
 * sniffing ad-hoc `__error` keys).
 */
type Completion<T> = { ok: true; value: T } | { ok: false; error: string };

/** Read a `Completion` from a signal payload: return the value, or throw a FatalError if it failed. */
function unwrapCompletion<T>(payload: unknown, label: string): T {
  const c = payload as Completion<T> | null;
  if (c && typeof c === 'object' && 'ok' in c && c.ok === false) {
    throw new FatalError(`${label} failed: ${c.error}`);
  }
  return (c as { value: T } | null)?.value as T;
}

/** A saga undo registered by a completed step, kept with its step name for visibility on failure. */
interface Compensation {
  name: string;
  fn: () => Promise<void>;
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
}

/**
 * The orchestrator. Owns workflow state and replays runs deterministically: each step's
 * result is checkpointed, so on resume a completed step returns its saved output instead of
 * re-executing. Remote steps are dispatched over the Transport; their results checkpoint the
 * same way local steps do.
 */
export class WorkflowEngine {
  private readonly store: StateStore;
  /** Ordered transport pool; `dispatch` tries them in order (failover). Empty = no remote steps. */
  private readonly transports: NamedTransport[];
  private readonly controlPlane?: ControlPlane;
  private readonly clock: () => number;
  private readonly instanceId: string;
  private readonly leaseMs: number;
  private readonly maxRecoveryAttempts?: number;
  private readonly webhookUrl?: (token: string) => string;
  private readonly traceparent?: () => string | undefined;
  private readonly compensationRetries: number;
  /** Every registered workflow, keyed by `name@version` — so old versions stay runnable. */
  private readonly workflows = new Map<string, RegisteredWorkflow>();
  /** The newest registered version per workflow name — used to `start` new runs. */
  private readonly latest = new Map<string, RegisteredWorkflow>();
  /** In-flight remote steps awaiting a worker result, keyed by stepId. */
  private readonly pending = new Map<string, PendingRemote>();
  /** Per-step "reset the liveness timer" callbacks, called when a heartbeat arrives. */
  private readonly heartbeatResets = new Map<string, () => void>();
  private readonly listeners = new Set<EngineListener>();
  /** Callbacks notified (on any instance) when a run is cancelled — for cooperative cancellation. */
  private readonly cancelListeners = new Set<(runId: string) => void>();
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
    this.transports =
      deps.transports ?? (deps.transport ? [{ id: 'default', transport: deps.transport }] : []);
    this.controlPlane = deps.controlPlane;
    this.clock = deps.clock ?? Date.now;
    this.instanceId = deps.instanceId ?? globalThis.crypto.randomUUID();
    this.leaseMs = deps.leaseMs ?? 30_000;
    this.maxRecoveryAttempts = deps.maxRecoveryAttempts;
    this.webhookUrl = deps.webhookUrl;
    this.traceparent = deps.traceparent;
    this.compensationRetries = Math.max(1, deps.compensationRetries ?? 1);
    // Listen for results/heartbeats on EVERY transport in the pool — a result can come back on
    // whichever one delivered the task (so failover is symmetric).
    for (const { transport } of this.transports) {
      transport.onResult(async (result) => {
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
      });
      // A heartbeat for an in-flight long step resets its liveness window (see callRemote).
      transport.onHeartbeat(async (beat) => {
        this.heartbeatResets.get(beat.stepId)?.();
      });
    }
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
  register(name: string, version: string, fn: WorkflowFn): void {
    const registered: RegisteredWorkflow = { name, version, fn };
    this.workflows.set(versionKey(name, version), registered);
    const current = this.latest.get(name);
    if (!current || isNewerVersion(version, current.version)) this.latest.set(name, registered);
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
   * Be notified when a run is cancelled — on ANY instance, via the transport control plane. A
   * worker bridge can use this for cooperative cancellation: abort the in-flight work for `runId`
   * instead of finishing it just to have the result discarded. Returns an unsubscribe function.
   */
  onCancel(listener: (runId: string) => void): () => void {
    this.cancelListeners.add(listener);
    return () => this.cancelListeners.delete(listener);
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

  async start(workflow: string, input: unknown, runId: string): Promise<RunResult> {
    const registered = this.latest.get(workflow);
    if (!registered) throw new Error(`workflow ${workflow} is not registered`);
    // Idempotent by run id: a redelivered trigger (at-least-once queues) or a scheduler re-tick for
    // the same id is a no-op, returning the existing run's state instead of starting a duplicate.
    const prior = await this.store.getRun(runId);
    if (prior) {
      return { runId, status: prior.status, output: prior.output, error: prior.error };
    }
    const now = new Date();
    const run: WorkflowRun = {
      id: runId,
      workflow,
      workflowVersion: registered.version,
      status: 'running',
      input,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createRun(run);
    this.emit({ type: 'run.started', runId, workflow });
    return this.track(this.execute(run, registered.fn));
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
   * Resume every run left incomplete by a crash or deploy. Called on boot. Completed steps
   * replay from their checkpoints, so only the work that had not finished runs again.
   */
  async recoverIncomplete(nowMs: number = this.clock()): Promise<RunResult[]> {
    if (this.draining) return [];
    const results: RunResult[] = [];
    for (const run of await this.store.listIncompleteRuns()) {
      const acquired = await this.store.tryLockRun(
        run.id,
        this.instanceId,
        nowMs + this.leaseMs,
        nowMs,
      );
      if (!acquired) continue;
      const attempts = (run.recoveryAttempts ?? 0) + 1;
      // Poison-pill guard: a run that keeps crashing the process on recovery is moved to the `dead`
      // dead-letter state instead of being retried forever (so it's inspectable, not a crash loop).
      if (this.maxRecoveryAttempts != null && attempts > this.maxRecoveryAttempts) {
        const error = {
          message: `run exceeded maxRecoveryAttempts (${this.maxRecoveryAttempts}) — moved to dead-letter`,
          code: 'max_recovery_attempts',
        };
        await this.store.updateRun(run.id, { status: 'dead', error, updatedAt: new Date() });
        await this.store.releaseRunLock(run.id);
        this.emit({ type: 'run.failed', runId: run.id, workflow: run.workflow, error });
        results.push({ runId: run.id, status: 'dead', error });
        continue;
      }
      // Count this attempt BEFORE resuming, so a crash mid-resume still advances the counter.
      await this.store.updateRun(run.id, { recoveryAttempts: attempts, updatedAt: new Date() });
      results.push(await this.resume(run.id));
    }
    return results;
  }

  /**
   * Resume every suspended run whose durable timer is due. Call periodically (a poller) and on
   * boot. A run still not due re-suspends cheaply without running new work.
   */
  async resumeDueTimers(nowMs: number = this.clock()): Promise<RunResult[]> {
    return this.resumeLeased(await this.store.listDueTimers(nowMs), nowMs);
  }

  /**
   * Resume each run only if this instance can acquire its recovery lease — so when several
   * replicas recover or poll at once, each run is picked up by exactly one of them.
   */
  private async resumeLeased(
    runs: WorkflowRun[],
    nowMs: number = this.clock(),
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
      if (acquired) results.push(await this.resume(run.id));
    }
    return results;
  }

  /**
   * Deliver an external signal to the run waiting on `token` and resume it with `payload`.
   * Returns the run result, or null if no run is waiting for that token.
   */
  async signal(token: string, payload: unknown): Promise<RunResult | null> {
    const waiter = await this.store.takeSignalWaiter(token);
    if (!waiter) return null;
    const at = new Date();
    await this.store.saveCheckpoint({
      runId: waiter.runId,
      seq: waiter.seq,
      name: `signal:${token}`,
      kind: 'signal',
      stepId: stepId(waiter.runId, waiter.seq),
      status: 'completed',
      output: payload,
      attempts: 1,
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });
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
  private async completeStep(step: {
    runId: string;
    seq: number;
    name: string;
    kind: StepKind;
    input?: unknown;
    output: unknown;
    events?: StepEvent[];
    attempts: number;
    enqueuedAt: Date;
    startedAt: Date;
    workerGroup?: string;
  }): Promise<void> {
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
  private async failStep(step: {
    runId: string;
    seq: number;
    name: string;
    kind: StepKind;
    input?: unknown;
    error: StepError;
    events?: StepEvent[];
    attempts: number;
    enqueuedAt: Date;
    startedAt: Date;
    workerGroup?: string;
  }): Promise<void> {
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

  private async execute(run: WorkflowRun, fn: WorkflowFn): Promise<RunResult> {
    // Saga compensations registered by completed steps; run in reverse if the run later fails.
    const compensations: Compensation[] = [];
    const ctx = this.makeCtx(run.id, compensations);
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

  private makeCtx(runId: string, compensations: Compensation[]): WorkflowCtx {
    let seq = -1;
    const nextSeq = () => {
      seq += 1;
      return seq;
    };
    const store = this.store;

    // Each ctx primitive is a named closure over `nextSeq` (the per-run logical position counter)
    // and `compensations` (the saga undo stack). They're defined up front so `task`/`child` can
    // compose `step`/`waitForSignal` directly — no post-construction mutation, no cast.

    const step = async <T>(
      name: string,
      fn: (log: StepLogger) => Promise<T>,
      options?: StepOptions,
    ): Promise<T> => {
      const current = nextSeq();
      const existing = await store.getCheckpoint(runId, current);
      if (existing && existing.name !== name) {
        throw new NonDeterminismError(runId, current, name, existing.name);
      }
      if (existing && existing.status === 'completed') {
        // Register the compensation on replay too, so a saga undoes ALL completed steps — even
        // those done in an earlier (since-suspended) pass — not just the ones run this pass.
        if (options?.compensate) compensations.push({ name, fn: options.compensate });
        return existing.output as T;
      }
      const maxAttempts = Math.max(1, options?.retries ?? 1);
      const startedAt = new Date();
      for (let attempt = 1; ; attempt += 1) {
        // Events are scoped per attempt — a retry starts a clean log, so the checkpoint reflects
        // only the attempt that actually completed (or the final failing one).
        const events: StepEvent[] = [];
        try {
          const output = await fn(createStepLogger(events, this.clock));
          await this.completeStep({
            runId,
            seq: current,
            name,
            kind: 'local',
            output,
            events,
            attempts: attempt,
            enqueuedAt: startedAt,
            startedAt,
          });
          if (options?.compensate) compensations.push({ name, fn: options.compensate });
          return output;
        } catch (err) {
          if (err instanceof FatalError || attempt >= maxAttempts) {
            await this.failStep({
              runId,
              seq: current,
              name,
              kind: 'local',
              error: {
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
              },
              events,
              attempts: attempt,
              enqueuedAt: startedAt,
              startedAt,
            });
            throw err;
          }
          // Wait out the backoff before the next attempt (no-op when backoffMs is unset).
          const wait = backoffDelay(attempt, options);
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    };

    const sleep = async (duration: string | number): Promise<void> => {
      const current = nextSeq();
      const now = this.clock();
      const existing = await store.getCheckpoint(runId, current);
      if (existing) {
        // Timer already recorded: resume if due, otherwise re-suspend cheaply.
        if (now >= (existing.wakeAt ?? 0)) return;
        throw new WorkflowSuspended(existing.wakeAt ?? now);
      }
      const wakeAt = now + parseDuration(duration);
      await this.recordTimer(runId, current, 'sleep', wakeAt);
      throw new WorkflowSuspended(wakeAt);
    };

    // NOTE (determinism): a bounded wait consumes TWO logical positions (deadline + wait), an
    // unbounded one consumes ONE. So adding or removing `{ timeoutMs }` on an existing
    // `waitForSignal` shifts the seq of every later step — treat it as a workflow-version change
    // (register a new @Workflow version) for runs already in flight.
    const waitForSignal = async <T>(token: string, opts?: { timeoutMs?: number }): Promise<T> => {
      if (opts?.timeoutMs == null) {
        const current = nextSeq();
        const existing = await store.getCheckpoint(runId, current);
        if (existing && existing.status === 'completed') return existing.output as T;
        await store.putSignalWaiter({ token, runId, seq: current });
        throw new WorkflowSuspended();
      }
      const timeoutMs = opts.timeoutMs;
      const deadlineSeq = nextSeq();
      const waitSeq = nextSeq();
      // The deadline is recorded durably as a timer checkpoint so replay knows it; the run also gets
      // a run-level wakeAt (via WorkflowSuspended) so the timer poller resumes it at the deadline.
      const recorded = await store.getCheckpoint(runId, deadlineSeq);
      const deadline = recorded?.wakeAt ?? this.clock() + timeoutMs;
      if (!recorded) await this.recordTimer(runId, deadlineSeq, `timeout:${token}`, deadline);

      const waited = await store.getCheckpoint(runId, waitSeq);
      if (waited && waited.status === 'completed') return waited.output as T;
      if (this.clock() >= deadline) {
        await store.takeSignalWaiter(token).catch(() => undefined);
        throw new SignalTimeoutError(token, timeoutMs);
      }
      await store.putSignalWaiter({ token, runId, seq: waitSeq });
      throw new WorkflowSuspended(deadline);
    };

    // An external task = a checkpointed dispatch + a wait for its async-completion `Completion`
    // (delivered by engine.completeTask/failTask). The whole "fire at a foreign system, suspend,
    // resume when it reports back" pattern as one call.
    const task = async <T>(
      name: string,
      dispatch: () => Promise<void>,
      options?: StepOptions,
    ): Promise<T> => {
      await step(`task:dispatch:${name}`, dispatch, options);
      return unwrapCompletion<T>(await waitForSignal(`task:${runId}:${name}`), `task "${name}"`);
    };

    // Child workflow: start it once, then suspend on a `child:<id>` waiter the child signals on its
    // terminal state (see notifyParent). The start is deferred to a microtask so it runs AFTER this
    // run suspends — a fast child can't reentrantly resume a parent that's still running.
    // A breakpoint = a visible `pending` checkpoint + a signal waiter the dashboard resumes via
    // `engine.continue`. Reuses the signal machinery (kind 'signal'), so resume overwrites the
    // pending checkpoint with a completed one and the run replays past it.
    const breakpoint = async (label?: string): Promise<void> => {
      const current = nextSeq();
      const existing = await store.getCheckpoint(runId, current);
      if (existing && existing.status === 'completed') return;
      if (!existing) {
        await this.recordBreakpoint(runId, current, label);
        await store.putSignalWaiter({
          token: breakpointToken(runId, current),
          runId,
          seq: current,
        });
      }
      throw new WorkflowSuspended();
    };

    const child = async <T>(workflow: string, input: unknown, childId?: string): Promise<T> => {
      const current = nextSeq();
      const id = childId ?? `${runId}.child.${current}`;
      const existing = await store.getCheckpoint(runId, current);
      if (existing && existing.status === 'completed') {
        return unwrapCompletion<T>(existing.output, `child "${id}"`);
      }
      await store.putSignalWaiter({ token: `child:${id}`, runId, seq: current });
      if (!(await store.getRun(id))) {
        queueMicrotask(() => {
          void this.start(workflow, input, id).catch(() => undefined);
        });
      }
      throw new WorkflowSuspended();
    };

    // Guard an in-place change: a fresh run records a `patch:<id>` marker here and takes the new
    // branch; a run recorded under the OLD code finds a real step at this position instead, so we
    // roll the logical position back (the marker is transparent to it) and return false — its replay
    // reads that old step next and follows the old branch. No position shift → no corruption.
    const patched = async (id: string): Promise<boolean> => {
      const marker = `patch:${id}`;
      const current = nextSeq();
      const existing = await store.getCheckpoint(runId, current);
      if (existing) {
        if (existing.name === marker) return true;
        if (existing.name.startsWith('patch:')) {
          throw new NonDeterminismError(runId, current, marker, existing.name);
        }
        seq -= 1; // not a marker: an old run's step lives here — give the position back to it
        return false;
      }
      const at = new Date();
      await store.saveCheckpoint({
        runId,
        seq: current,
        name: marker,
        kind: 'local',
        stepId: stepId(runId, current),
        status: 'completed',
        output: true,
        attempts: 1,
        enqueuedAt: at,
        startedAt: at,
        finishedAt: at,
      });
      return true;
    };

    // An update point: suspend on a run-scoped `update:<runId>:<name>` token that engine.update
    // delivers to (after its validator passes). Reuses the signal machinery; run-scoped like task/child.
    const onUpdate = <T>(name: string, opts?: { timeoutMs?: number }): Promise<T> =>
      waitForSignal<T>(`update:${runId}:${name}`, opts);

    // A queryable named value: a checkpoint whose `name` is `event:<key>`, so the latest value for a
    // key is just the highest-seq such checkpoint (read by engine.getEvent). Replay-idempotent.
    const setEvent = async (key: string, value: unknown): Promise<void> => {
      const current = nextSeq();
      const name = `event:${key}`;
      const existing = await store.getCheckpoint(runId, current);
      if (existing && existing.name !== name) {
        throw new NonDeterminismError(runId, current, name, existing.name);
      }
      if (existing && existing.status === 'completed') return; // replay: already published
      const at = new Date();
      await store.saveCheckpoint({
        runId,
        seq: current,
        name,
        kind: 'local',
        stepId: stepId(runId, current),
        status: 'completed',
        output: value,
        attempts: 1,
        enqueuedAt: at,
        startedAt: at,
        finishedAt: at,
      });
    };

    // A durable webhook reserves a logical position NOW to mint a stable token, so the url can be
    // handed to a third party before `wait()` suspends. `wait()` then parks on that same position
    // until the callback lands as engine.signal(token, body) — single position, replay-safe.
    const webhook = <T>(): DurableWebhook<T> => {
      const current = nextSeq();
      const token = `wh:${runId}:${current}`;
      const wait = async (): Promise<T> => {
        const existing = await store.getCheckpoint(runId, current);
        if (existing && existing.status === 'completed') return existing.output as T;
        await store.putSignalWaiter({ token, runId, seq: current });
        throw new WorkflowSuspended();
      };
      return { token, url: this.webhookUrl?.(token), wait };
    };

    // Deterministic non-deterministic sources: each is a checkpointed local step, so the value is
    // captured on the first run and replayed verbatim afterwards (a raw Date.now()/Math.random()
    // inside a workflow would differ across replays and corrupt the run).
    const now = () => step('now', async () => this.clock());
    const random = () => step('random', async () => Math.random());
    const uuid = () => step('uuid', async () => globalThis.crypto.randomUUID());

    return {
      runId,
      step,
      sleep,
      waitForSignal,
      task,
      child,
      breakpoint,
      webhook,
      setEvent,
      onUpdate,
      patched,
      now,
      random,
      uuid,
      call: <TInput, TOutput>(
        remote: RemoteStepDef<TInput, TOutput>,
        input: TInput,
        opts?: { queue?: string; transport?: string },
      ) => this.callRemote(runId, nextSeq(), remote, input, opts?.queue, opts?.transport),
    };
  }

  /** Persist a completed timer checkpoint (a durable sleep / signal deadline) at a logical position. */
  private async recordTimer(
    runId: string,
    seq: number,
    name: string,
    wakeAt: number,
  ): Promise<void> {
    const at = new Date();
    await this.store.saveCheckpoint({
      runId,
      seq,
      name,
      kind: 'sleep',
      stepId: stepId(runId, seq),
      status: 'completed',
      wakeAt,
      attempts: 1,
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });
  }

  /** Persist a `pending` checkpoint marking a breakpoint, so it's visible (and resumable) in the UI. */
  private async recordBreakpoint(runId: string, seq: number, label?: string): Promise<void> {
    const at = new Date();
    await this.store.saveCheckpoint({
      runId,
      seq,
      name: label ? `${BREAKPOINT}:${label}` : BREAKPOINT,
      kind: 'signal',
      stepId: stepId(runId, seq),
      status: 'pending',
      attempts: 1,
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });
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

  /** The transport pool ordered for dispatch: a pinned `preferId` first, then the rest (failover). */
  private orderedTransports(preferId?: string): NamedTransport[] {
    if (!preferId) return this.transports;
    const pref = this.transports.filter((t) => t.id === preferId);
    if (pref.length === 0) throw new Error(`transport "${preferId}" is not registered`);
    return [...pref, ...this.transports.filter((t) => t.id !== preferId)];
  }

  /**
   * Dispatch `task` over the pool: try the preferred (or first) transport, fail over to the next on
   * a dispatch error, and stamp the task with the id of the transport that accepted it (so a worker
   * replies on the matching one). Throws if every transport fails.
   */
  private async dispatchWithFailover(
    task: Omit<RemoteTask, 'transport'>,
    preferId?: string,
  ): Promise<void> {
    let lastErr: unknown;
    for (const { id, transport } of this.orderedTransports(preferId)) {
      try {
        await transport.dispatch({ ...task, transport: id });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('no transport accepted the dispatch');
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
    if (this.transports.length === 0) throw new Error('remote steps require a Transport');
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
    await this.dispatchWithFailover(
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
    if (this.transports.length === 0) throw new Error('remote steps require a Transport');
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
      await this.dispatchWithFailover(
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
