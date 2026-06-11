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

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

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
  createdAt: Date;
  updatedAt: Date;
}

export type StepKind = 'local' | 'remote';

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
// StateStore — where runs and checkpoints live (Postgres-first via ORM adapters)
// ---------------------------------------------------------------------------

export interface StateStore {
  createRun(run: WorkflowRun): Promise<void>;
  updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void>;
  getRun(runId: string): Promise<WorkflowRun | null>;

  getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null>;
  /**
   * Persist a checkpoint and advance the run atomically. Durable semantics depend on this
   * being a single transaction; stores without transactions cannot give the strong guarantee.
   */
  saveCheckpoint(checkpoint: StepCheckpoint): Promise<void>;

  /** Used by recovery on boot to find runs to resume. */
  listIncompleteRuns(): Promise<WorkflowRun[]>;

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
  /** Durable sleep that survives restarts (fase 2). */
  sleep?(duration: string): Promise<void>;
}

/** Result of executing or resuming a workflow run. */
export interface RunResult {
  runId: string;
  status: RunStatus;
  output?: unknown;
  error?: StepError;
}
