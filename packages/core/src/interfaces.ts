import type { z } from 'zod';

/**
 * Core type contracts for nestjs-durable.
 *
 * These are intentionally framework-agnostic: `@dudousxd/nestjs-durable-core` knows only
 * these interfaces, never a concrete transport, store or ORM. Adapters implement them.
 */

// ---------------------------------------------------------------------------
// Runs & checkpoints — the durable state owned by the orchestrator
// ---------------------------------------------------------------------------

export type RunStatus = 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';

/** One execution of a workflow. The unit of durability and the unit shown in the dashboard. */
export interface WorkflowRun {
  id: string;
  /** Registered workflow name, e.g. `checkout`. */
  workflow: string;
  /** Code version at start; old runs must resume on the version they began on. */
  workflowVersion: string;
  status: RunStatus;
  /** Serialized workflow input (the args the run was started with). */
  input: unknown;
  /** Serialized workflow output, once `completed`. */
  output?: unknown;
  /** Structured error, once `failed`. */
  error?: StepError;
  /** When `suspended` on a durable sleep: epoch ms at which the run becomes due to resume. */
  wakeAt?: number;
  /** Recovery lease owner (engine instance id) while a run is being resumed. */
  lockedBy?: string;
  /** Recovery lease expiry (epoch ms); another instance may take over once it passes. */
  lockedUntil?: number;
  createdAt: Date;
  updatedAt: Date;
}

export type StepKind = 'local' | 'remote' | 'sleep' | 'signal';

/**
 * The recorded result of a single step at a deterministic logical position (`seq`).
 * On replay, a present checkpoint means the step is NOT re-executed — its `output` is returned.
 */
export interface StepCheckpoint {
  runId: string;
  /** Deterministic logical position of the step within the run. */
  seq: number;
  /** Registered step name (matches the remote handler name for remote steps). */
  name: string;
  kind: StepKind;
  /** Stable id passed to remote workers so they can dedupe a re-delivered task. */
  stepId: string;
  /**
   * `pending` = a remote step dispatched and awaiting its worker result (the run is durably
   * suspended, not held in memory); it becomes `completed`/`failed` when the result arrives.
   */
  status: 'pending' | 'completed' | 'failed';
  /** What the step was called with — the `ctx.call` args for a remote step (a local step has none). */
  input?: unknown;
  output?: unknown;
  error?: StepError;
  attempts: number;
  /** For remote steps: which worker group ran it. */
  workerGroup?: string;
  /** Structured events/logs the step emitted (sub-step outcomes, debug/error lines). */
  events?: StepEvent[];
  /** For sleep steps: epoch ms the sleep elapses at. */
  wakeAt?: number;
  /**
   * When the step entered the system: for a remote step, when the engine dispatched it to the
   * transport; for a local step, when it began. Queue-wait time = `startedAt − enqueuedAt`.
   */
  enqueuedAt: Date;
  /** When processing actually began: worker pickup for a remote step, execution start for a local one. */
  startedAt: Date;
  finishedAt: Date;
}

/**
 * A structured event a step (or its worker) emits while running — a log line and/or a sub-step
 * outcome. The dashboard renders these under the step, so you can see what happened inside a step
 * that the workflow treats as one unit (e.g. which of N parallel sub-processes ok/failed/skipped).
 */
export interface StepEvent {
  /** Epoch ms. */
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  /** For a sub-step/sub-process within the step: its name. */
  name?: string;
  /** For a sub-step: its outcome. */
  status?: 'ok' | 'failed' | 'skipped';
  /** Optional structured payload. */
  data?: unknown;
}

/**
 * Handed to a local step's body (`ctx.step(name, (log) => …)`) so it can record what happened
 * inside the step — debug/info/warn/error lines and per-sub-process outcomes. The events are
 * checkpointed with the step and rendered under it in the dashboard. The remote/cross-language
 * counterpart is the worker attaching the same `StepEvent[]` to its `StepResult` (see the Python
 * SDK's `StepContext`), so observability is symmetric regardless of where the step ran.
 */
export interface StepLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** Record a sub-step / sub-process outcome (e.g. one of N parallel p-processes). */
  sub(name: string, status: 'ok' | 'failed' | 'skipped', message?: string, data?: unknown): void;
}

export interface StepError {
  message: string;
  /** Optional machine-readable code, e.g. `declined`, `timeout`. */
  code?: string;
  /** Whether the engine should treat this as retryable. */
  retryable?: boolean;
  stack?: string;
}

// ---------------------------------------------------------------------------
// StateStore — where runs and checkpoints live (Postgres / MySQL / SQLite via ORM adapters)
// ---------------------------------------------------------------------------

export interface StateStore {
  /**
   * Provision the tables/collections this store needs, idempotently. Called on boot when the
   * module's `autoSchema` is on. Optional: stores that need no setup (in-memory) omit it.
   */
  ensureSchema?(): Promise<void>;

  createRun(run: WorkflowRun): Promise<void>;
  updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void>;
  getRun(runId: string): Promise<WorkflowRun | null>;

  getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null>;
  /**
   * Persist a checkpoint and advance the run atomically. Durable semantics depend on this
   * being a single transaction; stores without transactions cannot give the strong guarantee.
   */
  saveCheckpoint(checkpoint: StepCheckpoint): Promise<void>;

  /** Used by recovery on boot to find runs to resume (crashed, left `running`). */
  listIncompleteRuns(): Promise<WorkflowRun[]>;

  /** Suspended runs whose durable timer is due (`wakeAt <= nowMs`), ready to resume. */
  listDueTimers(nowMs: number): Promise<WorkflowRun[]>;

  /**
   * Atomically acquire the recovery lease on a run for `owner` until `leaseUntilMs`, but only if
   * it is currently unlocked or its lease has expired (`<= nowMs`). Returns whether it was
   * acquired — so concurrent engine instances never recover the same run twice.
   */
  tryLockRun(runId: string, owner: string, leaseUntilMs: number, nowMs: number): Promise<boolean>;

  /** Release a run's recovery lease so another instance can pick it up (e.g. once it suspends). */
  releaseRunLock(runId: string): Promise<void>;

  /** Record that a run is suspended waiting for an external signal `token`. */
  putSignalWaiter(waiter: SignalWaiter): Promise<void>;
  /** Atomically take (and remove) the run waiting on `token`, if any. */
  takeSignalWaiter(token: string): Promise<SignalWaiter | null>;

  // Dashboard queries
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
  listCheckpoints(runId: string): Promise<StepCheckpoint[]>;
}

export interface RunQuery {
  workflow?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

/** Binds an external signal `token` to the suspended run/step position waiting for it. */
export interface SignalWaiter {
  token: string;
  runId: string;
  seq: number;
}

// ---------------------------------------------------------------------------
// Transport — how a remote task travels to a worker and the result returns
// ---------------------------------------------------------------------------

/** A unit of work dispatched to a remote worker. This is the documented wire payload. */
export interface RemoteTask {
  runId: string;
  seq: number;
  /** Handler name the worker registered, e.g. `payments.charge-card`. */
  name: string;
  stepId: string;
  /** Worker group expected to handle this task. */
  group: string;
  input: unknown;
  /** W3C traceparent so the worker can continue the distributed trace. */
  traceparent?: string;
  attempt: number;
}

export interface StepResult {
  runId: string;
  seq: number;
  stepId: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: StepError;
  /** Epoch ms when the worker began processing — lets the engine report queue-wait time. */
  startedAt?: number;
  /** Structured events the worker emitted while running the step (sub-step outcomes, logs). */
  events?: StepEvent[];
}

export interface Heartbeat {
  runId: string;
  seq: number;
  stepId: string;
  group: string;
}

export interface Transport {
  /** engine → worker */
  dispatch(task: RemoteTask): Promise<void>;
  /** worker → engine: a step finished (ok or error). */
  onResult(handler: (result: StepResult) => Promise<void>): void;
  /** worker → engine: liveness signal for an in-flight long step. */
  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void;
  /**
   * Optional **control plane** — a broadcast pub/sub across ALL engine instances (every pod), as
   * opposed to `dispatch`/`onResult` which are point-to-point work queues. It carries things every
   * instance may need to see regardless of who's running the run: lifecycle events (so a
   * dashboard-only pod can live-tail a run executing on a worker pod) and cancellation (so the pod
   * actually running a run learns it was cancelled elsewhere). In-process transports broadcast
   * locally; a cross-process transport (BullMQ) fans out over its broker (Redis pub/sub). Omit on
   * transports that can't broadcast — the engine degrades to local-only events.
   */
  publishControl?(msg: ControlMessage): Promise<void>;
  onControl?(handler: (msg: ControlMessage) => void): void;
}

/** A message on the {@link Transport} control plane — see `publishControl`/`onControl`. `from` is
 *  the originating engine's `instanceId`, so a broker that echoes a publish back to its own
 *  subscriber (e.g. Redis pub/sub) can be deduped by the originator. */
export type ControlMessage = { from?: string } & (
  | { kind: 'event'; event: EngineEvent }
  | { kind: 'cancel'; runId: string }
);

// ---------------------------------------------------------------------------
// Authoring — workflows, local steps, and typed remote steps
// ---------------------------------------------------------------------------

export type BackoffStrategy = 'fixed' | 'exp';

export interface StepOptions {
  /** Max attempts before the step (and run) fails. */
  retries?: number;
  /** How the delay between retries grows: `fixed` (constant) or `exp` (doubles each attempt). */
  backoff?: BackoffStrategy;
  /** Base delay in ms between retries. Omit (or 0) to retry with no delay. */
  backoffMs?: number;
  /** Upper bound on the (exponential) backoff delay. */
  backoffMaxMs?: number;
  /** Add random jitter (50–100% of the computed delay) to avoid thundering-herd retries. */
  jitter?: boolean;
  /**
   * Liveness window for a **remote** step (`ctx.call`): if the worker produces no result and no
   * heartbeat within this many ms, the engine presumes it dead and fails the dispatch with a
   * `RemoteStepTimeout` (retryable — it re-dispatches per `retries`). Each heartbeat resets the
   * window. Ignored for local steps. Omit to wait indefinitely.
   */
  timeoutMs?: number;
  /**
   * Saga compensation: if this step completes but the run later **fails**, the engine runs the
   * registered `compensate` callbacks in reverse order (undo what was done). Local steps only.
   * Idempotency note: a step is already deduplicated by its deterministic `stepId` (runId:seq) —
   * remote workers can use it as the idempotency key, so there's no separate key option.
   */
  compensate?: () => Promise<void>;
}

/**
 * A typed handle to a step that runs on a remote worker. The `name` string is the contract:
 * the worker registers a handler under the same name. `input`/`output` validate at the boundary.
 */
export interface RemoteStepDef<TInput = unknown, TOutput = unknown> extends StepOptions {
  name: string;
  /** Worker group expected to handle this step. */
  group: string;
  input: z.ZodType<TInput>;
  output: z.ZodType<TOutput>;
  /** Branding so `ctx.call` can infer types. */
  readonly __remote: true;
}

/**
 * A durable webhook handle minted by {@link WorkflowCtx.webhook}. Hand `url` to a third party,
 * then `await wait()` — the run suspends with zero compute until the external system POSTs the
 * callback (delivered as `engine.signal(token, body)`), and resumes with the body.
 */
export interface DurableWebhook<TPayload = unknown> {
  /** Deterministic signal token (`wh:<runId>:<seq>`) the callback delivers on — stable across replay. */
  readonly token: string;
  /**
   * Public callback URL for `token`, built by the engine's `webhookUrl` option. Hand this to the
   * third party. `undefined` when no builder is configured (use {@link DurableWebhook.token} to
   * build your own).
   */
  readonly url?: string;
  /** Suspend until the callback arrives, then resume with its payload. */
  wait(): Promise<TPayload>;
}

/**
 * The context handed to a workflow function. Every interaction with the outside world goes
 * through it so the engine can checkpoint — the workflow body itself stays deterministic.
 */
export interface WorkflowCtx {
  readonly runId: string;
  /**
   * Run a local durable step: executed once, then its result is checkpointed and replayed. The
   * body receives a {@link StepLogger} to record debug/error lines and sub-process outcomes — these
   * are checkpointed with the step and shown under it in the dashboard.
   */
  step<TOutput>(
    name: string,
    fn: (log: StepLogger) => Promise<TOutput>,
    options?: StepOptions,
  ): Promise<TOutput>;
  /**
   * Dispatch a typed remote step and await its checkpointed result. Pass `{ queue }` to subject the
   * dispatch to a registered flow-control queue (concurrency / rate limit) — see `engine.registerQueue`.
   */
  call<TInput, TOutput>(
    step: RemoteStepDef<TInput, TOutput>,
    input: TInput,
    opts?: { queue?: string },
  ): Promise<TOutput>;
  /**
   * Durable sleep: suspends the run for `duration` (e.g. `'30s'`, `'2h'`, `'7 days'`, or ms as a
   * number) without consuming resources, resuming automatically once the timer is due — even
   * across restarts.
   */
  sleep(duration: string | number): Promise<void>;
  /**
   * Suspend the run until an external `engine.signal(token, payload)` arrives (e.g. a webhook or
   * human approval), then resume with the payload. Waits indefinitely by default — no compute
   * consumed. Pass `{ timeoutMs }` to bound the wait: if the deadline passes first the call throws
   * a `SignalTimeoutError` (catch it in the workflow to branch).
   */
  waitForSignal<TPayload>(token: string, opts?: { timeoutMs?: number }): Promise<TPayload>;
  /**
   * An external task with **async completion**: run `dispatch` once (checkpointed — e.g. send to a
   * queue, kick off a non-durable worker or a foreign service like a Python process), then suspend
   * with zero compute until `engine.completeTask(runId, name, result)` (or `failTask`) reports back,
   * and resume with the result. The durable, first-class counterpart of the hand-rolled
   * "dispatch over SQS → wait for COMPLETE_PHASE → signal" pattern. `name` must be unique per run.
   */
  task<TResult>(
    name: string,
    dispatch: () => Promise<void>,
    options?: StepOptions,
  ): Promise<TResult>;
  /**
   * Run another registered workflow as a **tracked child**: starts it once and suspends — zero
   * compute — until the child reaches a terminal state, then resumes with the child's output (or
   * throws a FatalError if the child failed). `childId` defaults to a deterministic id derived from
   * this run and the call position, so it's stable across replay.
   */
  child<TOutput>(workflow: string, input: unknown, childId?: string): Promise<TOutput>;
  /**
   * Pause the run at this point until a human resumes it from the dashboard (or
   * `engine.continue(runId)`). Records a visible `pending` checkpoint so the breakpoint shows up
   * in the timeline, then suspends with zero compute — the durable equivalent of a debugger
   * breakpoint. Gate it on your own config to make breakpoints opt-in per run:
   * `if (cfg.breakAfterExtraction) await ctx.breakpoint('after-extraction')`.
   */
  breakpoint(label?: string): Promise<void>;
  /**
   * Mint a durable webhook: returns a handle with a deterministic `token` and (if the engine has a
   * `webhookUrl` builder) a public `url`. Hand the url to a third party — inside a `ctx.step` — then
   * `await handle.wait()` to suspend with zero compute until they POST the callback (the dashboard
   * turns that POST into `engine.signal(token, body)`). The first-class, replay-safe version of
   * "expose a callback URL and wait for it".
   */
  webhook<TPayload>(): DurableWebhook<TPayload>;
  /**
   * Publish a named, queryable value from inside the run — the latest value for `key` is readable
   * externally via `engine.getEvent(runId, key)` while the run is still in flight (progress, a
   * partial result, a status). Checkpointed and replay-safe (overwrites the previous value for the
   * same key). The read side has no effect on the run — the durable, suspend-model counterpart of a
   * Temporal query.
   */
  setEvent<TValue>(key: string, value: TValue): Promise<void>;
  /**
   * Expose a named **update point**: suspend until an external `engine.update(runId, name, arg)`
   * delivers `arg`, then resume with it. The update is run-scoped (`name` need only be unique within
   * the run) and gated by any validator registered via `engine.registerUpdateValidator` — a rejected
   * update never reaches here. Pass `{ timeoutMs }` to bound the wait (throws `SignalTimeoutError`).
   * The durable counterpart of a Temporal update handler.
   */
  onUpdate<TArg>(name: string, opts?: { timeoutMs?: number }): Promise<TArg>;
  /**
   * Guard an in-place workflow change without a new version. Wrap the changed code in
   * `if (await ctx.patched('my-change')) { …new… } else { …old… }`: a fresh run records a marker and
   * takes the new branch (`true`); a run already recorded under the old code keeps the old branch
   * (`false`), because its history has a real step where the marker would sit. The marker is
   * position-transparent for old runs (it doesn't shift their recorded steps), so guarding code is
   * replay-safe. Once every old run has drained, remove the guard (keep the new branch).
   */
  patched(id: string): Promise<boolean>;
  /**
   * Deterministic wall-clock (epoch ms): records the time on the first run and replays the SAME
   * value afterwards. Use this instead of `Date.now()` inside a workflow — a raw `Date.now()` returns
   * a different value on every replay, which silently corrupts a durable run.
   */
  now(): Promise<number>;
  /**
   * Deterministic random in `[0, 1)`: recorded once, then replayed. Use instead of `Math.random()`
   * (same replay-safety reason as {@link now}).
   */
  random(): Promise<number>;
  /** Deterministic UUID v4: recorded once, then replayed. Use instead of `crypto.randomUUID()`. */
  uuid(): Promise<string>;
}

/** Result of executing or resuming a workflow run. */
export interface RunResult {
  runId: string;
  status: RunStatus;
  output?: unknown;
  error?: StepError;
}

/**
 * Validates an incoming `engine.update` before it is delivered to the run. Throw (or return a
 * non-empty string) to reject — the run is left untouched. Return nothing/void to accept. May be
 * async (e.g. a business-rule check against a DB).
 */
export type UpdateValidator<TArg = unknown> = (
  arg: TArg,
) => void | string | Promise<void | string>;

/** Outcome of `engine.update`: rejected by the validator, or accepted and delivered. */
export type UpdateResult =
  | { accepted: false; reason: string }
  | { accepted: true; run: RunResult | null };

export type EngineEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.suspended'
  | 'step.started'
  | 'step.completed'
  | 'step.failed';

/**
 * A lifecycle event emitted by the engine. The observability surfaces (dashboard, OTel, the
 * Telescope integration) all subscribe to these rather than reaching into the store.
 */
export interface EngineEvent {
  type: EngineEventType;
  runId: string;
  workflow?: string;
  seq?: number;
  name?: string;
  kind?: StepKind;
  output?: unknown;
  error?: StepError;
  /** Wall-clock duration of the unit that just finished (step or run), when known. */
  durationMs?: number;
  /** For a remote step: how long it waited in the queue before a worker picked it up. */
  queueMs?: number;
  at: Date;
}

export type EngineListener = (event: EngineEvent) => void;
