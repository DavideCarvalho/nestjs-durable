/**
 * Thrown inside a step to signal an unrecoverable failure: the engine will NOT retry it,
 * regardless of the step's `retries` setting, and fails the run immediately. Use it for
 * business errors that retrying cannot fix (e.g. a declined card, invalid input).
 */
export class FatalError extends Error {
  readonly code?: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'FatalError';
    this.code = code;
  }
}

/**
 * Thrown by `start` when a singleton workflow's wait queue is full: the count of in-flight + gated
 * runs sharing the key already equals `limit + maxQueueDepth`, so admitting another would let the
 * same-key backlog grow unbounded. Back-pressure — the caller should retry later or shed load. Only
 * raised when {@link SingletonConfig.maxQueueDepth} is set (omit it for the old unbounded behavior).
 */
export class SingletonQueueFullError extends Error {
  readonly workflow: string;
  readonly key: string;
  readonly maxQueueDepth: number;
  constructor(workflow: string, key: string, maxQueueDepth: number) {
    super(
      `singleton queue for ${workflow} key "${key}" is full (maxQueueDepth=${maxQueueDepth}); retry later`,
    );
    this.name = 'SingletonQueueFullError';
    this.workflow = workflow;
    this.key = key;
    this.maxQueueDepth = maxQueueDepth;
  }
}

/**
 * Internal control signal thrown to suspend a run (e.g. on a durable sleep). Not an error the
 * user should throw or catch; the engine uses it to stop execution and persist `wakeAt`.
 */
export class SignalTimeoutError extends Error {
  readonly token: string;
  readonly timeoutMs: number;
  constructor(token: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for signal "${token}"`);
    this.name = 'SignalTimeoutError';
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a remote step produces no result and no heartbeat within its `timeoutMs` window —
 * i.e. the worker is presumed dead. Subject to the step's `retries` (it's retryable), so the engine
 * re-dispatches before giving up.
 */
export class RemoteStepTimeout extends Error {
  readonly stepId: string;
  readonly timeoutMs: number;
  constructor(stepId: string, timeoutMs: number) {
    super(`remote step ${stepId} produced no result/heartbeat within ${timeoutMs}ms`);
    this.name = 'RemoteStepTimeout';
    this.stepId = stepId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown by a remote {@link WorkflowExecutor} (e.g. {@link RemoteWorkflowExecutor}) when an `advance`
 * does not produce its decision within the configured `timeoutMs` — i.e. the worker is presumed gone
 * (the decision was dropped by a stall/redelivery or an instance restart spanning the in-memory waiter
 * map). Crucially this is NOT a run failure: the work may have actually completed and only the decision
 * was lost. The engine treats it as RECOVERABLE — it releases the run lease and leaves the run
 * `running` so `recoverIncomplete` re-drives it deterministically (replaying completed steps from
 * history). Distinct from a real executor error, which still fails the run.
 *
 * OPT-IN: only thrown when the executor was constructed with a `timeoutMs`. Absent a timeout, the
 * engine awaits the decision with its prior (unbounded) behavior — so existing users see no change.
 *
 * Known hazard: a timeout that fires while a worker is LEGITIMATELY still executing a not-yet-
 * checkpointed step will re-drive and re-run that in-flight step → DUPLICATE side effects. Therefore
 * the timeout is only safe when set GENEROUSLY (longer than the longest legitimate single turn). The
 * robust fix — a liveness/heartbeat-rearmed deadline so only a genuinely-dead worker re-drives — is the
 * documented follow-up (see the Track A diagnosis doc, "Part B").
 */
export class RemoteWorkflowTimeout extends Error {
  readonly taskId: string;
  readonly timeoutMs: number;
  constructor(taskId: string, timeoutMs: number) {
    super(
      `remote workflow task ${taskId} produced no decision within ${timeoutMs}ms — presumed dropped; re-driving via recovery`,
    );
    this.name = 'RemoteWorkflowTimeout';
    this.taskId = taskId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown on resume when the workflow code no longer matches the recorded history: the step at a
 * logical position has a different name/kind than the checkpoint saved there. This means the
 * workflow definition changed (a step was added/removed/reordered) under an in-flight run without a
 * new `@Workflow` version — continuing would replay the wrong checkpoint into the wrong step and
 * silently corrupt the run, so the engine fails loudly instead. Register a new workflow version for
 * breaking changes (old runs finish on the version they started on).
 */
export class NonDeterminismError extends Error {
  readonly runId: string;
  readonly seq: number;
  constructor(runId: string, seq: number, expected: string, recorded: string) {
    super(
      `non-determinism at ${runId}#${seq}: code expects "${expected}" but history recorded ` +
        `"${recorded}". The workflow changed under an in-flight run — register a new @Workflow version.`,
    );
    this.name = 'NonDeterminismError';
    this.runId = runId;
    this.seq = seq;
  }
}

export class WorkflowSuspended extends Error {
  /** Epoch ms to auto-resume (durable sleep), or undefined when waiting on an external signal. */
  readonly wakeAt?: number | undefined;
  constructor(wakeAt?: number) {
    super('workflow suspended');
    this.name = 'WorkflowSuspended';
    this.wakeAt = wakeAt;
  }
}

/**
 * Thrown by `ctx.continueAsNew(input)` to end the current run and hand off to a fresh execution of
 * the same workflow with a clean history — for long-running / looping workflows that would otherwise
 * accumulate unbounded checkpoints. The engine completes this run and starts the next one.
 */
export class ContinueAsNew extends Error {
  constructor(readonly input: unknown) {
    super('workflow continued as new');
    this.name = 'ContinueAsNew';
  }
}
