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
  status: 'completed' | 'failed';
  output?: unknown;
  error?: StepError;
  attempts: number;
  /** For remote steps: which worker group ran it. */
  workerGroup?: string;
  /** For sleep steps: epoch ms the sleep elapses at. */
  wakeAt?: number;
  startedAt: Date;
  finishedAt: Date;
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
}

// ---------------------------------------------------------------------------
// Authoring — workflows, local steps, and typed remote steps
// ---------------------------------------------------------------------------

export type BackoffStrategy = 'fixed' | 'exp';

export interface StepOptions {
  /** Max attempts before the step (and run) fails. */
  retries?: number;
  backoff?: BackoffStrategy;
  /** Base delay in ms for backoff. */
  backoffMs?: number;
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
 * The context handed to a workflow function. Every interaction with the outside world goes
 * through it so the engine can checkpoint — the workflow body itself stays deterministic.
 */
export interface WorkflowCtx {
  readonly runId: string;
  /** Run a local durable step: executed once, then its result is checkpointed and replayed. */
  step<TOutput>(name: string, fn: () => Promise<TOutput>, options?: StepOptions): Promise<TOutput>;
  /** Dispatch a typed remote step and await its checkpointed result. */
  call<TInput, TOutput>(step: RemoteStepDef<TInput, TOutput>, input: TInput): Promise<TOutput>;
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
  task<TResult>(name: string, dispatch: () => Promise<void>, options?: StepOptions): Promise<TResult>;
  /**
   * Run another registered workflow as a **tracked child**: starts it once and suspends — zero
   * compute — until the child reaches a terminal state, then resumes with the child's output (or
   * throws a FatalError if the child failed). `childId` defaults to a deterministic id derived from
   * this run and the call position, so it's stable across replay.
   */
  child<TOutput>(workflow: string, input: unknown, childId?: string): Promise<TOutput>;
}

/** Result of executing or resuming a workflow run. */
export interface RunResult {
  runId: string;
  status: RunStatus;
  output?: unknown;
  error?: StepError;
}

export type EngineEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.suspended'
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
  at: Date;
}

export type EngineListener = (event: EngineEvent) => void;
