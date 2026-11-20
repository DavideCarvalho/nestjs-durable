import type {
  ChildCallOptions,
  DurableWebhook,
  HistoryEvent,
  SearchAttributes,
  Settled,
  StepDispatchOpts,
  StepError,
  StepEvent,
  StepLogger,
  StepOptions,
  StepRef,
  WaitAnyCondition,
  WaitAnyResult,
  WaitCondition,
  WaitConditionSpec,
  WaitForRunOptions,
  WorkflowClass,
  WorkflowCommand,
  WorkflowCtx,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowRef,
  WorkflowStepEvent,
} from '@dudousxd/nestjs-durable-core';
import {
  NestedWorkflowCallError,
  type RemoteWorkflowFeature,
  SignalTimeoutError,
  createStepLogger,
  currentStepScope,
  parseDuration,
  remoteCallPolicyOf,
  remoteCallRetries,
  retryLocalStep,
  runInStepLogger,
  runInStepScope,
  stepConfigOf,
  stepNameOf,
  workflowName,
} from '@dudousxd/nestjs-durable-core';
import {
  Cancelled,
  ContinuedAsNew,
  type GatherFailure,
  GatherReplayError,
  NondeterminismError,
  StepFailed,
  Suspend,
  UnsupportedByControlPlane,
  UnsupportedOnThinWorker,
  toError,
} from './errors';

/** Mode for the parallel ops: `waitAll` records/awaits every item then aggregates failures;
 *  `failFast` surfaces the first failure as soon as it is seen. Mirrors Python `wait_all`/`fail_fast`. */
export type GatherMode = 'waitAll' | 'failFast';

/**
 * Events sink handed to a `ctx.step` body so it can record sub-events (logs + sub-process outcomes),
 * captured onto the step's `recordStep` command. The TS twin of the Python SDK's `StepContext.events`.
 * It is the engine's full {@link StepLogger} so a `@Workflow` body written against `WorkflowCtx.step`
 * (whose `fn` receives a `StepLogger`) runs unchanged on the thin worker.
 */
export type StepLog = StepLogger;

/** The body a `ctx.step` runs. Receives a {@link StepLogger} sink; sync or async. */
export type StepBody<T> = (log: StepLogger) => Promise<T> | T;

/** Options for constructing a {@link WorkflowContext}. */
export interface WorkflowContextOptions {
  /**
   * The isolation partition of the WORKFLOW this context replays (the worker's own partition, if
   * any). A dispatched `ctx.step` call carries no per-call partition of its own — the emitted `call`
   * decision's `group` always inherits THIS partition — see {@link WorkflowContext.step}. The runner
   * ({@link import('./workflow-worker').WorkflowWorker}) threads its own partition in here.
   * Absent → the step's decision carries no partition (routes on the bare sanitized name).
   */
  workflowPartition?: string | undefined;
  /** Signals delivered to the run but not yet consumed, so `waitSignal` resolves on replay. */
  pendingSignals?: Array<{ seq: number; signal: string; payload: unknown }> | undefined;
  /**
   * Best-effort sink that streams each local step's lifecycle (running → completed/failed) live, so
   * a long inline turn's steps show up as they happen instead of only at the end. A broken sink must
   * never fail the workflow.
   */
  onStep?: ((event: WorkflowStepEvent) => void) | undefined;
  /**
   * Cooperative cancellation source (the runner feeds it from the control channel). The replay bails
   * at the next op boundary when this reports the run cancelled — see {@link WorkflowContext.next}.
   */
  isCancelled?: ((runId: string) => boolean) | undefined;
  /**
   * The workflow-decision features the dispatching control plane applies (`WorkflowTask.features`).
   * An op whose command needs a feature not listed fails the turn with
   * {@link UnsupportedByControlPlane} instead of emitting it. Absent = a control plane from before
   * feature negotiation: only the original command kinds.
   */
  features?: readonly string[] | undefined;
  /**
   * How many times a `localStep`'s `compensate` closure is tried when the turn fails and the saga
   * unwinds (see {@link WorkflowContext.runCompensations}). The engine's `compensationRetries`; default 1.
   */
  compensationRetries?: number | undefined;
}

/** A completed `localStep`'s registered undo, unwound in reverse when the turn fails. */
interface LocalCompensation {
  name: string;
  fn: () => Promise<void>;
}

/**
 * The replay context handed to a workflow function. Its ops are deterministic: same code + same
 * history ⇒ same seqs ⇒ same decisions. A faithful port of the Python `durable_worker` `WorkflowContext`:
 * history in → commands out, suspend by throwing {@link Suspend}.
 *
 * It `implements` the engine's {@link WorkflowCtx}, so a NestJS `@Workflow` body typed against
 * `WorkflowCtx` runs UNCHANGED on the thin worker. The API splits in two:
 *
 * - **Supported** (wire-expressible) — {@link step} (always dispatched — no local placement; its
 *   retries/backoff/timeout ride the `call` as its `policy`), {@link sleep}, {@link sleepUntil},
 *   {@link waitForSignal} (bounded or not), {@link waitForEvent}, {@link waitForAny}, {@link child},
 *   {@link startChild} (fire-and-forget), {@link all}, {@link continueAsNew}, {@link setEvent},
 *   {@link now}/{@link sideEffect} (deterministic capture, backed by the internal {@link localStep}
 *   primitive): each maps to a {@link WorkflowCommand} the engine applies durably. The newer commands
 *   are negotiated: see {@link WorkflowContextOptions.features}.
 * - **Unsupported** — `transaction`, `callEntity`, `signalEntity`, `waitForRun`, `task`,
 *   `breakpoint`, `webhook`, `onUpdate`, `patched`, `upsertSearchAttributes`: they need engine/store/
 *   transport features the remote wire can't express yet, so each throws
 *   {@link UnsupportedOnThinWorker} (run such a workflow in-process on the engine).
 *
 * {@link gather} is a worker-only extension (Python `gather` parity) beyond `WorkflowCtx`.
 */
export class WorkflowContext implements WorkflowCtx {
  /** New durable ops this turn produced, ordered by seq. */
  readonly commands: WorkflowCommand[] = [];

  /** The run this turn replays. Always set by the worker (`task.runId`); `WorkflowCtx` requires it. */
  readonly runId: string;

  private readonly history: Map<number, HistoryEvent>;
  private readonly signalsBySeq: Map<number, { seq: number; signal: string; payload: unknown }>;
  private readonly onStep: ((event: WorkflowStepEvent) => void) | undefined;
  private readonly isCancelled: ((runId: string) => boolean) | undefined;
  private readonly workflowPartition: string | undefined;
  private readonly features: ReadonlySet<string>;
  private readonly compensationRetries: number;
  /** Saga undos of completed local steps, in completion order; rebuilt identically on every replay. */
  private readonly compensations: LocalCompensation[] = [];
  private seq = 0;

  constructor(runId: string, history: HistoryEvent[], opts: WorkflowContextOptions = {}) {
    this.runId = runId;
    this.history = new Map(history.map((e) => [e.seq, e]));
    this.signalsBySeq = new Map((opts.pendingSignals ?? []).map((s) => [s.seq, s]));
    this.onStep = opts.onStep;
    this.isCancelled = opts.isCancelled;
    this.workflowPartition = opts.workflowPartition;
    this.features = new Set(opts.features ?? []);
    this.compensationRetries = Math.max(1, opts.compensationRetries ?? 1);
  }

  /** Fail the turn when the dispatching control plane cannot apply `feature` (see the options). */
  private requireFeature(feature: RemoteWorkflowFeature, op: string): void {
    if (!this.features.has(feature)) throw new UnsupportedByControlPlane(op, feature);
  }

  // -- internals -----------------------------------------------------------

  /** Best-effort: stream a step lifecycle event. A broken sink must never fail the workflow. */
  private emitStep(event: WorkflowStepEvent): void {
    if (this.onStep === undefined) return;
    try {
      this.onStep(event);
    } catch {
      // live-tail is best-effort observability
    }
  }

  /**
   * Abort the turn at the next op boundary when the run has been cancelled — automatic between-step
   * cancellation with no `if (ctx.cancelled)` checks in user code. Mirrors Python `_raise_if_cancelled`.
   */
  private raiseIfCancelled(): void {
    if (this.isCancelled?.(this.runId)) {
      throw new Cancelled(this.runId);
    }
  }

  /**
   * Every durable op takes its seq from here, so this is the single choke point where between-op
   * cancellation is enforced for the whole workflow API. Mirrors Python `_next`.
   */
  private next(primitive: string): number {
    this.raiseIfCancelled();
    // Fail fast when called from INSIDE one of this ctx's local-step bodies (see core's
    // NestedWorkflowCallError): the step replays from history without re-running its body, so the
    // position claimed here would never be claimed again and every later op would shift. A position
    // already present in history was journaled before this guard existed — let it replay as written.
    const scope = currentStepScope();
    if (scope !== undefined && scope.owner === this && !this.history.has(this.seq)) {
      throw new NestedWorkflowCallError(this.runId, primitive, scope.step);
    }
    const seq = this.seq;
    this.seq += 1;
    return seq;
  }

  /**
   * `{found, output}` for a resolved op in history; raises on kind/name mismatch or re-raises a
   * recorded failure. Mirrors Python `_replay`.
   */
  private replay(
    seq: number,
    kind: HistoryEvent['kind'],
    name?: string,
  ): { found: boolean; output: unknown } {
    const ev = this.history.get(seq);
    if (ev === undefined) return { found: false, output: undefined };
    this.guard(ev, seq, kind, name);
    if (ev.error != null) throw new StepFailed(ev.error);
    return { found: true, output: ev.output };
  }

  /**
   * Like {@link replay}, but returns the raw history entry (or `null` if absent) instead of
   * unwrapping output / raising on a recorded failure — so gather can aggregate failures itself.
   * Still enforces the kind/name nondeterminism guard. Mirrors Python `_replay_entry`.
   */
  replayEntry(seq: number, kind: HistoryEvent['kind'], name?: string): HistoryEvent | null {
    const ev = this.history.get(seq);
    if (ev === undefined) return null;
    this.guard(ev, seq, kind, name);
    return ev;
  }

  /**
   * Resolve the `group` field a `call` decision carries: a `call` decision emitted by a replaying
   * worker carries the WORKFLOW's own partition ONLY — never a full queue token — because the engine
   * composes the final routing token itself via `tenantGroup(sanitizeQueueToken(cmd.name), cmd.group)`.
   * The single-step `ctx.step` surface has no per-call partition override (that capability lived on
   * the old `RemoteStepDef.partition`, removed with it); the rule is simply: the WORKFLOW's own
   * partition ({@link workflowPartition}), else `''` (no partition at all — `tenantGroup` treats `''`
   * identically to `undefined`, i.e. a bare token). The `''` floor exists only because the wire's
   * `group` field is a required `string`. Mirrors the Python SDK's parity rule (Task 8).
   */
  private resolveCallGroup(): string {
    return this.workflowPartition ?? '';
  }

  private guard(ev: HistoryEvent, seq: number, kind: HistoryEvent['kind'], name?: string): void {
    const nameMismatch = name !== undefined && ev.name != null && ev.name !== name;
    if (ev.kind !== kind || nameMismatch) {
      throw new NondeterminismError(
        this.runId,
        seq,
        `${kind}/${JSON.stringify(name)}`,
        `${ev.kind}/${JSON.stringify(ev.name)}`,
      );
    }
  }

  // -- the workflow API (supported) ----------------------------------------

  /**
   * ONE durable step primitive: always dispatched, always engine-scheduled — no local/remote
   * placement choice for the workflow author (see `WorkflowCtx.step`). Resolve the routing name off
   * a `@Step`-stamped handler reference (via {@link stepNameOf}), or take it literally for the
   * cross-runtime string form; the reference itself is NEVER invoked here — only its stamped name is
   * read (the serving worker re-resolves the real handler from DI), so an unbound `this` on `handler`
   * is irrelevant. Emits the SAME `call` decision + `Suspend` a pre-rename `ctx.remote` did — the wire
   * is unchanged (Task 1/2). `opts` (`queue`/`priority`/`fairnessKey`/`transport`) are engine-side
   * ADMISSION concerns — accepted for `WorkflowCtx` conformance, but the remote wire has no place for
   * them, so they don't change the worker's emitted command.
   *
   * The decision's `group` field carries the WORKFLOW's own partition (or `''`) — see
   * {@link resolveCallGroup}; there is no per-call partition override in this surface.
   *
   * **Step policy.** `retries`/`backoff`/`backoffMs`/`backoffMaxMs`/`jitter`/`timeoutMs` — from
   * `opts`, else from the `@Step`-stamped config (`stepConfigOf`), the in-process merge — ride the
   * `call` as its `policy`, and the control plane enforces them as a standalone engine does: a failed
   * attempt the policy retries (see core's `remoteCallRetries`) is re-emitted here instead of raised,
   * and the control plane spaces it by the backoff; a `timeoutMs` step is re-dispatched when its
   * window lapses. A control plane that cannot (no `callPolicy` feature) fails the turn instead.
   */
  async step<TInput, TOutput>(
    handler: StepRef<TInput, TOutput>,
    input: TInput,
    opts?: StepDispatchOpts,
  ): Promise<TOutput>;
  async step<TOutput = unknown>(
    name: string,
    input: unknown,
    opts?: StepDispatchOpts,
  ): Promise<TOutput>;
  async step(
    handlerOrName: StepRef | string,
    input: unknown,
    opts?: StepDispatchOpts,
  ): Promise<unknown> {
    const name = typeof handlerOrName === 'string' ? handlerOrName : stepNameOf(handlerOrName);
    if (name === undefined) {
      throw new Error(
        'ctx.step: handler is not a @Step reference (no stamped step name) — pass a @Step-decorated method or a step name string',
      );
    }
    const config = typeof handlerOrName === 'string' ? undefined : stepConfigOf(handlerOrName);
    const policy = remoteCallPolicyOf(config, opts);
    const seq = this.next('step');
    const ev = this.replayEntry(seq, 'call', name);
    if (ev !== null) {
      if (ev.error == null) return ev.output;
      // A failed attempt its policy retries is not the step's outcome yet: re-emit the call, and the
      // control plane dispatches it again once the backoff has passed.
      if (!remoteCallRetries(policy, ev.attempts ?? 1, ev.error)) throw new StepFailed(ev.error);
    }
    if (policy !== undefined)
      this.requireFeature('callPolicy', 'step with retries/backoff/timeoutMs');
    const group = this.resolveCallGroup();
    this.commands.push({
      kind: 'call',
      seq,
      name,
      group,
      input,
      ...(policy !== undefined ? { policy } : {}),
    });
    throw new Suspend();
  }

  /**
   * The checkpointed LOCAL-step primitive (also backing {@link sideEffect}/{@link now}): run `fn` in
   * this process and record its result, so side effects / non-determinism happen exactly once and
   * replay returns the captured value. The body receives a {@link StepLogger}.
   *
   * `options` apply as they do in-process (core's `createWorkflowCtx`), through the same
   * `retryLocalStep` loop: `retries` is the total attempt count, a failed attempt waits
   * `backoffDelay` (`backoff`/`backoffMs`/`backoffMaxMs`/`jitter`) in process before the next, a
   * `FatalError` is never retried, and once attempts run out the step records the LAST attempt's
   * error (its `code` and `details` intact) with `attempts` set, then raises it as {@link StepFailed}.
   * The wait is not a durable timer, in-process included: a worker that dies mid-backoff replays the
   * turn and runs the step again from attempt 1. A `compensate` closure is registered when the step
   * completes (and again on every replay of it), and runs in reverse when the turn fails (see
   * {@link runCompensations}).
   *
   * Not part of the public {@link WorkflowCtx} surface (the public single step is always dispatched —
   * see {@link step}), but present at runtime for the SAME reason core's `createWorkflowCtx` result
   * carries it: the two runtimes' ctx objects must expose the SAME member set (see
   * `ctx-conformance.spec.ts`).
   */
  async localStep<TOutput>(
    name: string,
    fn: (log: StepLogger) => Promise<TOutput> | TOutput,
    options?: StepOptions,
  ): Promise<TOutput> {
    const seq = this.next('localStep');
    const { found, output } = this.replay(seq, 'step', name);
    if (found) {
      if (options?.compensate) this.compensations.push({ name, fn: options.compensate });
      return output as TOutput;
    }

    const { output: result, error } = await this.runStepBody(seq, name, fn, undefined, options);
    if (error !== undefined) throw new StepFailed(error);
    if (options?.compensate) this.compensations.push({ name, fn: options.compensate });
    return result as TOutput;
  }

  /**
   * The saga unwind for a failed turn: run every registered `localStep` `compensate` in reverse, each
   * tried up to `compensationRetries` times, and record each outcome as a `compensate:<step>` step at
   * the negative position `-(k + 1)` the engine gives its own unwind, so the undo trail shows in run
   * detail as it does in-process. A failing undo is recorded and skipped, never raised: it must not
   * mask the turn's original failure or strand the undos after it. An undo already in history is
   * skipped. Called by the worker once a turn ends in a failure; a cancelled turn does not unwind.
   * Internal to the runtime: workflow code never calls it.
   */
  async runCompensations(): Promise<void> {
    const total = this.compensations.length;
    for (let i = total - 1; i >= 0; i -= 1) {
      const comp = this.compensations[i];
      if (comp === undefined) continue;
      const seq = -(total - i);
      if (this.history.has(seq)) continue;
      const name = `compensate:${comp.name}`;
      const startedAt = Date.now();
      let attempts = 0;
      let error: StepError | undefined;
      for (let attempt = 1; attempt <= this.compensationRetries; attempt += 1) {
        attempts = attempt;
        try {
          await comp.fn();
          error = undefined;
          break;
        } catch (err) {
          error = { message: err instanceof Error ? err.message : String(err) };
        }
      }
      const finishedAt = Date.now();
      this.commands.push({
        kind: 'recordStep',
        seq,
        name,
        ...(error !== undefined ? { error } : {}),
        attempts,
        startedAt,
        finishedAt,
      });
      this.emitStep({
        runId: this.runId,
        seq,
        name,
        phase: error !== undefined ? 'failed' : 'completed',
        startedAt,
        finishedAt,
        ...(error !== undefined ? { error } : {}),
      });
    }
  }

  /**
   * Run one local step body through the shared `retryLocalStep` loop (`options` as in
   * {@link localStep}; none means one attempt), record its `recordStep` command (with `attempts`, and
   * `parallelGroup` when set) and stream its lifecycle. Returns `{output}` on success or `{error}`
   * (the last attempt's) on failure WITHOUT throwing, so {@link localStep} and {@link gather} can
   * decide how to surface it. The single place a local step's side effects + recording happen.
   */
  private async runStepBody(
    seq: number,
    name: string,
    body: StepBody<unknown>,
    parallelGroup?: string,
    options?: StepOptions,
  ): Promise<{ output?: unknown; error?: StepError; events: StepEvent[] }> {
    const startedAt = Date.now();
    const runId = this.runId;
    this.emitStep({ runId, seq, name, phase: 'running', startedAt, parallelGroup });

    // Events are scoped per attempt: the record carries only the attempt that completed (or the
    // final failing one), as in-process.
    let events: StepEvent[] = [];
    const outcome = await retryLocalStep(options, async () => {
      const attemptEvents: StepEvent[] = [];
      events = attemptEvents;
      const log = createStepLogger(attemptEvents, () => Date.now());
      // Bind the SAME sink ambiently too, so a helper deep inside the body can emit via
      // `currentStep()` without the handle being threaded down (see core's `ambient-step.ts`).
      return runInStepScope(this, name, () => runInStepLogger(log, () => body(log)));
    });
    const finishedAt = Date.now();
    const cmd: WorkflowCommand = { kind: 'recordStep', seq, name, startedAt, finishedAt };
    if (outcome.ok) cmd.output = outcome.value;
    else cmd.error = toError(outcome.error);
    if (outcome.attempts > 1) cmd.attempts = outcome.attempts;
    if (events.length > 0) cmd.events = events;
    if (parallelGroup !== undefined) cmd.parallelGroup = parallelGroup;
    this.commands.push(cmd);
    if (outcome.ok) {
      this.emitStep({
        runId,
        seq,
        name,
        phase: 'completed',
        startedAt,
        finishedAt,
        output: outcome.value,
        events,
        parallelGroup,
      });
      return { output: outcome.value, events };
    }
    const error = toError(outcome.error);
    this.emitStep({
      runId,
      seq,
      name,
      phase: 'failed',
      startedAt,
      finishedAt,
      error,
      events,
      parallelGroup,
    });
    return { error, events };
  }

  /**
   * Durable sleep: suspends the run for `duration` (e.g. `'30s'`, `'2h'`, or ms as a number); the
   * engine resumes it when the timer fires. The duration is parsed to ms HERE (`parseDuration`) and
   * the engine computes the absolute deadline when it applies the `sleep` command. Mirrors Python
   * `sleep` and matches `WorkflowCtx.sleep`.
   */
  async sleep(duration: string | number): Promise<void> {
    const seq = this.next('sleep');
    const { found } = this.replay(seq, 'timer');
    if (found) return;
    this.commands.push({ kind: 'sleep', seq, ms: parseDuration(duration) });
    throw new Suspend();
  }

  /**
   * Suspend until an external signal `token` is delivered to this run, then resume with its payload.
   * Mirrors Python `wait_signal`; renamed from the old `waitSignal` to match `WorkflowCtx.waitForSignal`.
   *
   * **Unbounded** (no `timeoutMs`) consumes ONE seq and emits a `waitSignal` command.
   *
   * **Bounded** (`opts.timeoutMs` set) takes TWO seqs in the in-process order — the deadline, then the
   * wait — so history lines up across runtimes, and emits a `waitSignalTimeout` command (feature
   * `waitSignalTimeout`); the control plane owns the clock. A deadline that lapses first raises a
   * {@link SignalTimeoutError}, as in-process. Adding or removing `timeoutMs` shifts every later seq,
   * exactly as it does in-process.
   */
  async waitForSignal<TPayload>(token: string, opts?: { timeoutMs?: number }): Promise<TPayload> {
    if (opts?.timeoutMs == null) {
      const seq = this.next('waitForSignal');
      const { found, output } = this.replay(seq, 'signal', token);
      if (found) return output as TPayload;
      const sig = this.signalsBySeq.get(seq);
      if (sig !== undefined) return sig.payload as TPayload;
      this.commands.push({ kind: 'waitSignal', seq, signal: token });
      throw new Suspend();
    }
    const timeoutMs = opts.timeoutMs;
    const deadlineSeq = this.next('waitForSignal');
    const seq = this.next('waitForSignal');
    const { found, output } = this.replay(seq, 'signal', token);
    if (found) return output as TPayload;
    const sig = this.signalsBySeq.get(seq);
    if (sig !== undefined) return sig.payload as TPayload;
    if (this.replayEntry(deadlineSeq, 'timer') !== null) {
      throw new SignalTimeoutError(token, timeoutMs);
    }
    this.requireFeature('waitSignalTimeout', 'waitForSignal with timeoutMs');
    this.commands.push({ kind: 'waitSignalTimeout', seq, deadlineSeq, signal: token, timeoutMs });
    throw new Suspend();
  }

  /**
   * Durable wait for whichever of `conditions` happens first — the thin-worker twin of the engine's
   * `ctx.waitForAny`. Takes ONE seq and emits a `waitAny` command; the ENGINE resolves it (timers
   * included: it owns the clock, and a timer's `ms` counts from when it first applies the command),
   * journals `{ key, value }` and replays it as an `any` history event. A child condition that won
   * with a failure replays as that event's `error`, re-raised here as {@link StepFailed}.
   */
  async waitForAny<C extends Record<string, WaitCondition<unknown>>>(
    name: string,
    conditions: C,
  ): Promise<WaitAnyResult<C>> {
    const seq = this.next('waitForAny');
    const { found, output } = this.replay(seq, 'any', name);
    if (found) return output as WaitAnyResult<C>;
    this.commands.push({
      kind: 'waitAny',
      seq,
      name,
      conditions: Object.entries(conditions).map(
        ([key, c]): WaitAnyCondition => ({ ...(c as WaitConditionSpec), key }),
      ),
    });
    throw new Suspend();
  }

  /** A signal condition for {@link waitForAny}. Matches `WorkflowCtx.signalWait`. */
  signalWait<TPayload = unknown>(token: string): WaitCondition<TPayload> {
    return { kind: 'signal', signal: token };
  }

  /** A timer condition for {@link waitForAny}. Matches `WorkflowCtx.timer`. */
  timer(duration: string | number | { until: Date | number }): WaitCondition<null> {
    if (typeof duration === 'object') {
      const { until } = duration;
      return { kind: 'timer', until: typeof until === 'number' ? until : until.getTime() };
    }
    return { kind: 'timer', ms: parseDuration(duration) };
  }

  /** A child condition for {@link waitForAny}: run `childId` settling. Matches `WorkflowCtx.childWait`. */
  childWait<C extends WorkflowClass>(
    workflow: C,
    childId: string,
  ): WaitCondition<WorkflowOutputOf<C>>;
  childWait<TOutput = unknown>(childId: string): WaitCondition<TOutput>;
  childWait(first: WorkflowRef, second?: string): WaitCondition<unknown> {
    return {
      kind: 'child',
      childId: typeof first === 'string' && second === undefined ? first : (second as string),
    };
  }

  /**
   * Run another registered workflow as a tracked child and await its result (its own durable
   * lifecycle): emit a `startChild` command and suspend; on resume, replay returns the recorded
   * output. Accepts a workflow ref — a class (resolved to its registered name via {@link workflowName})
   * or a name string. This is the AWAIT-a-child op; the wire `startChild` command IS this await-setup.
   * Mirrors Python `start_child` and matches `WorkflowCtx.child`. (`options` — childId/priority — are
   * engine-side and don't reach the wire command yet.)
   */
  child<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    options?: string | ChildCallOptions,
  ): Promise<WorkflowOutputOf<C>>;
  child<TOutput>(
    workflow: string,
    input: unknown,
    options?: string | ChildCallOptions,
  ): Promise<TOutput>;
  async child(
    workflow: WorkflowRef,
    input: unknown,
    _options?: string | ChildCallOptions,
  ): Promise<unknown> {
    const name = workflowName(workflow);
    const seq = this.next('child');
    const { found, output } = this.replay(seq, 'child', name);
    if (found) return output;
    this.commands.push({ kind: 'startChild', seq, workflow: name, input });
    throw new Suspend();
  }

  /**
   * Run N LOCAL step bodies CONCURRENTLY and wait for all (Node: `Promise` over the bodies, no
   * threads). Reserves a contiguous seq block in list order BEFORE running any body — the determinism
   * anchor, identical to a sequence of `step` calls, so replay reaches the same seqs regardless of
   * which body settles first. Records each outcome as a `recordStep` command in seq order, every one
   * tagged with the same `parallelGroup` (`gather:<firstSeq>`).
   *
   * `waitAll` (default): await all, record all, throw {@link GatherReplayError} if any failed.
   * `failFast`: still records every started body's outcome, then throws {@link GatherReplayError} carrying
   *   the failures. Returns results in input order. Deterministic: on replay (all seqs already in
   *   history) it reconstructs the result/raise from history WITHOUT invoking any body. Mirrors
   *   Python `gather`.
   */
  async gather(
    items: Array<[name: string, body: StepBody<unknown>]>,
    opts: { mode?: GatherMode } = {},
  ): Promise<unknown[]> {
    // Reserve the contiguous seq block synchronously, in list order, before any await. This is the
    // determinism anchor: seqs are assigned by position, never by completion order.
    const entries = items.map(([name, body], index) => ({
      index,
      seq: this.next('gather'),
      name,
      body,
    }));
    const first = entries[0];
    if (first === undefined) return [];
    const group = `gather:${first.seq}`;

    // Replay: inline steps all record in ONE turn, so either ALL or NONE of the seqs are present.
    const replayed = entries.map((e) => this.replayEntry(e.seq, 'step', e.name));
    if (replayed.every((ev) => ev !== null)) {
      const failures: GatherFailure[] = [];
      const outputs = entries.map((e, i) => {
        const ev = replayed[i] as HistoryEvent;
        if (ev.error != null) {
          failures.push({ index: e.index, name: e.name, error: ev.error });
          return undefined;
        }
        return ev.output;
      });
      if (failures.length > 0) throw new GatherReplayError(failures);
      return outputs;
    }

    // failFast and waitAll both record every started body's outcome (a JS Promise can't be killed
    // mid-flight); both raise once any item failed — the mode only governs intent for parity.
    const results = await Promise.all(
      entries.map((e) => this.runStepBody(e.seq, e.name, e.body, group)),
    );

    const failures: GatherFailure[] = [];
    const outputs = entries.map((e, i) => {
      const r = results[i];
      if (r?.error !== undefined) {
        failures.push({ index: e.index, name: e.name, error: r.error });
        return undefined;
      }
      return r?.output;
    });
    if (failures.length > 0) throw new GatherReplayError(failures);
    return outputs;
  }

  /**
   * Dispatch N child workflows CONCURRENTLY and wait for ALL their outputs (gather_children parity).
   * Reserves a contiguous seq block in input order; on the first turn emits a `startChild` command
   * for every input (each tagged `parallelGroup` = `gather:<firstSeq>`) in ONE turn, then suspends.
   * On each child completion the parent resumes; a resume re-emits ONLY the still-outstanding children
   * (idempotent on the engine — a child has no history entry until it settles). Once ALL children have
   * resolved it returns their outputs in input order.
   *
   * `waitAll` (default): aggregate failures into {@link GatherReplayError}. `failFast`: raise as soon as a
   * failed child is seen on a resume (siblings are not force-cancelled in v1). Empty inputs → `[]`.
   * Accepts a workflow ref (class or name); resolved to its registered name via {@link workflowName}.
   * Mirrors Python `gather_children` and matches `WorkflowCtx.all`.
   */
  all<C extends WorkflowClass>(
    workflow: C,
    inputs: WorkflowInputOf<C>[],
    opts?: { mode?: GatherMode },
  ): Promise<WorkflowOutputOf<C>[]>;
  all<TOutput = unknown>(
    workflow: string,
    inputs: unknown[],
    opts?: { mode?: GatherMode },
  ): Promise<TOutput[]>;
  async all(
    workflow: WorkflowRef,
    inputs: unknown[],
    opts: { mode?: GatherMode } = {},
  ): Promise<unknown[]> {
    const { name, entries } = this.childFan(workflow, inputs, opts.mode ?? 'waitAll');
    const failures: GatherFailure[] = [];
    const outputs = entries.map((e) => {
      if (e.history.error != null) {
        failures.push({ index: e.index, workflow: name, error: e.history.error });
        return undefined;
      }
      return e.history.output;
    });
    if (failures.length > 0) throw new GatherReplayError(failures);
    return outputs;
  }

  /**
   * {@link all} that resolves with one {@link Settled} per child, in input order, instead of throwing
   * for a failed one. The same fan as `all` in `waitAll` mode. Matches `WorkflowCtx.allSettled`; a
   * rejected item's `id` is the child run id the engine minted for it (`<runId>.child.<seq>`).
   */
  allSettled<C extends WorkflowClass>(
    workflow: C,
    inputs: WorkflowInputOf<C>[],
  ): Promise<Settled<WorkflowOutputOf<C>>[]>;
  allSettled<TOutput = unknown>(workflow: string, inputs: unknown[]): Promise<Settled<TOutput>[]>;
  async allSettled(workflow: WorkflowRef, inputs: unknown[]): Promise<Settled<unknown>[]> {
    const { entries } = this.childFan(workflow, inputs, 'waitAll');
    return entries.map(
      (e): Settled<unknown> =>
        e.history.error != null
          ? {
              status: 'rejected',
              id: `${this.runId}.child.${e.seq}`,
              error: e.history.error.message,
              ...(e.history.error.code !== undefined ? { code: e.history.error.code } : {}),
              ...(e.history.error.details !== undefined
                ? { details: e.history.error.details }
                : {}),
            }
          : { status: 'fulfilled', value: e.history.output },
    );
  }

  /** The fan `all` and `allSettled` share: returns once every child has settled, suspends before. */
  private childFan(
    workflow: WorkflowRef,
    inputs: unknown[],
    mode: GatherMode,
  ): { name: string; entries: { index: number; seq: number; history: HistoryEvent }[] } {
    const name = workflowName(workflow);
    const entries = inputs.map((input, index) => ({
      index,
      seq: this.next('all'),
      input,
      history: undefined as HistoryEvent | null | undefined,
    }));
    const first = entries[0];
    if (first === undefined) return { name, entries: [] };
    const group = `gather:${first.seq}`;
    for (const e of entries) e.history = this.replayEntry(e.seq, 'child', name);

    if (mode === 'failFast') {
      for (const e of entries) {
        if (e.history?.error != null) {
          throw new GatherReplayError([{ index: e.index, workflow: name, error: e.history.error }]);
        }
      }
    }

    let pending = false;
    for (const e of entries) {
      if (e.history == null) {
        this.commands.push({
          kind: 'startChild',
          seq: e.seq,
          workflow: name,
          input: e.input,
          parallelGroup: group,
        });
        pending = true;
      }
    }
    if (pending) throw new Suspend();
    return {
      name,
      entries: entries.map((e) => ({
        index: e.index,
        seq: e.seq,
        history: e.history as HistoryEvent,
      })),
    };
  }

  // -- deterministic sources (recorded once, replayed) ---------------------

  /**
   * Deterministic wall-clock, epoch **milliseconds**: recorded as a `now` local step on the first run
   * and replayed verbatim afterwards. Implemented as a recorded {@link localStep} exactly like the
   * engine's ctx. Matches `WorkflowCtx.now`.
   */
  now(): Promise<number> {
    return this.localStep('now', async () => Date.now());
  }

  /**
   * **Deterministic capture.** Run `fn` once, checkpoint its result, and on replay return the SAME
   * value WITHOUT re-running `fn` — the durable way to bring a non-deterministic value into a
   * workflow where the author controls the generator (`uuidv7`/`ulid`/`Math.random`/a config read).
   * Recorded as a `sideEffect` local step, exactly like the engine's ctx. Matches
   * `WorkflowCtx.sideEffect`. There is no baked `uuid`/`random` helper — see {@link now} for the one
   * ubiquitous convenience.
   */
  sideEffect<TValue>(fn: () => TValue | Promise<TValue>): Promise<TValue> {
    return this.localStep('sideEffect', async () => fn());
  }

  // -- unsupported on the thin worker --------------------------------------
  //
  // These `WorkflowCtx` members exist so the class is assignable to `WorkflowCtx` (a `@Workflow`
  // body still type-checks), but they need engine/store/transport features the remote wire protocol
  // can't express. Each throws {@link UnsupportedOnThinWorker} — run such a workflow in-process on
  // the engine, or rewrite it against a wire-expressible op.

  /** Single throw site for every unsupported op (`never` so it satisfies any return type). */
  private unsupported(op: string): never {
    throw new UnsupportedOnThinWorker(op);
  }

  /** UNSUPPORTED: needs a transactional store (exactly-once DB write + checkpoint in one tx). */
  async transaction<TOutput>(
    _name: string,
    _fn: (tx: unknown) => Promise<TOutput>,
  ): Promise<TOutput> {
    return this.unsupported('transaction');
  }

  /** UNSUPPORTED: searchAttributes live on the engine-owned run record; a thin worker has no store.
   *  Run such a workflow in-process on the engine, where `ctx.upsertSearchAttributes` is durable. */
  async upsertSearchAttributes(_attrs: SearchAttributes): Promise<void> {
    return this.unsupported('upsertSearchAttributes');
  }

  /** UNSUPPORTED: durable entities run on the engine over durable state, not on the worker. */
  async callEntity<TResult = unknown>(
    _name: string,
    _key: string,
    _op: string,
    _arg?: unknown,
  ): Promise<TResult> {
    return this.unsupported('callEntity');
  }

  /** UNSUPPORTED: see {@link callEntity}. */
  async signalEntity(_name: string, _key: string, _op: string, _arg?: unknown): Promise<void> {
    return this.unsupported('signalEntity');
  }

  /**
   * End this run and hand off to a fresh execution (clean history) with `input` — `<runId>~N`, as
   * in-process. Terminal: it always throws, so code after it is unreachable. Emits a `continueAsNew`
   * command (feature `continueAsNew`) as the turn's last; the control plane completes this run and
   * starts the continuation.
   */
  async continueAsNew(input?: unknown): Promise<never> {
    this.raiseIfCancelled();
    this.requireFeature('continueAsNew', 'continueAsNew');
    this.commands.push({ kind: 'continueAsNew', seq: this.seq, input });
    throw new ContinuedAsNew();
  }

  /**
   * Durable sleep until an absolute deadline (`Date` or epoch ms): emits a `sleepUntil` command
   * (feature `sleepUntil`) — one seq, recorded once, so a replay never moves the deadline.
   */
  async sleepUntil(when: Date | number): Promise<void> {
    const seq = this.next('sleepUntil');
    const { found } = this.replay(seq, 'timer');
    if (found) return;
    this.requireFeature('sleepUntil', 'sleepUntil');
    this.commands.push({
      kind: 'sleepUntil',
      seq,
      until: typeof when === 'number' ? when : when.getTime(),
    });
    throw new Suspend();
  }

  /**
   * Wait for a named event published with `engine.publishEvent(name, payload)` whose payload matches
   * `opts.match` (buffered events included, tenant-scoped as in-process). Emits a `waitEvent` command
   * (feature `waitEvent`). Bounded by `timeoutMs` like {@link waitForSignal}: two seqs, deadline first,
   * and a lapsed deadline raises a {@link SignalTimeoutError} for `event:<name>`.
   */
  async waitForEvent<TPayload>(
    name: string,
    opts?: { match?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<TPayload> {
    const match = opts?.match;
    if (opts?.timeoutMs == null) {
      const seq = this.next('waitForEvent');
      const { found, output } = this.replay(seq, 'signal');
      if (found) return output as TPayload;
      this.requireFeature('waitEvent', 'waitForEvent');
      this.commands.push({ kind: 'waitEvent', seq, name, ...(match ? { match } : {}) });
      throw new Suspend();
    }
    const timeoutMs = opts.timeoutMs;
    const deadlineSeq = this.next('waitForEvent');
    const seq = this.next('waitForEvent');
    const { found, output } = this.replay(seq, 'signal');
    if (found) return output as TPayload;
    if (this.replayEntry(deadlineSeq, 'timer') !== null) {
      throw new SignalTimeoutError(`event:${name}`, timeoutMs);
    }
    this.requireFeature('waitEvent', 'waitForEvent');
    this.commands.push({
      kind: 'waitEvent',
      seq,
      name,
      ...(match ? { match } : {}),
      deadlineSeq,
      timeoutMs,
    });
    throw new Suspend();
  }

  /** UNSUPPORTED: waiting on another run's settle is delivered by the engine from the store. */
  waitForRun(
    _first: WorkflowRef,
    _runId?: string | WaitForRunOptions,
    _opts?: WaitForRunOptions,
  ): Promise<never> {
    return this.unsupported('waitForRun');
  }

  /** UNSUPPORTED: async-completion tasks (`engine.completeTask`/`failTask`) are engine-driven. */
  async task<TResult>(
    _name: string,
    _dispatch: () => Promise<void>,
    _options?: StepOptions,
  ): Promise<TResult> {
    return this.unsupported('task');
  }

  /**
   * Start a child workflow WITHOUT awaiting it and return its run id at once (the turn goes on).
   * Emits a `spawnChild` command (feature `spawnChild`); the control plane starts the child once,
   * idempotent by id, on the parent's partition and tenant, and journals `spawn:<childId>` here so a
   * replay returns the same id. `options.childId` and `options.priority` apply; `version` and
   * `parentClose` are not carried on the remote protocol yet and throw {@link UnsupportedOnThinWorker}.
   */
  startChild<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    options?: string | ChildCallOptions,
  ): Promise<string>;
  startChild(
    workflow: string,
    input: unknown,
    options?: string | ChildCallOptions,
  ): Promise<string>;
  async startChild(
    workflow: WorkflowRef,
    input: unknown,
    options?: string | ChildCallOptions,
  ): Promise<string> {
    const opts: ChildCallOptions =
      typeof options === 'string' ? { childId: options } : (options ?? {});
    if (opts.version !== undefined) this.unsupported('startChild with version');
    if (opts.parentClose !== undefined) this.unsupported('startChild with parentClose');
    const name = workflowName(workflow);
    const seq = this.next('startChild');
    const childId = opts.childId ?? `${this.runId}.child.${seq}`;
    const ev = this.replayEntry(seq, 'step', `spawn:${childId}`);
    if (ev !== null) return (ev.output as string | undefined) ?? childId;
    this.requireFeature('spawnChild', 'startChild');
    this.commands.push({
      kind: 'spawnChild',
      seq,
      workflow: name,
      input,
      childId,
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    });
    return childId;
  }

  /** UNSUPPORTED: a breakpoint records a visible `pending` checkpoint the engine resumes. */
  async breakpoint(_label?: string): Promise<void> {
    return this.unsupported('breakpoint');
  }

  /** UNSUPPORTED: minting a durable webhook needs the engine's `webhookUrl` builder + signal store. */
  webhook<TPayload>(): DurableWebhook<TPayload> {
    return this.unsupported('webhook');
  }

  /**
   * Publish a queryable named value, read with `engine.getEvent(runId, key)`: recorded as the
   * `event:<key>` step the in-process ctx writes (a `recordStep`, which every control plane applies,
   * so this needs no feature). Replay-idempotent: a recorded position is skipped.
   */
  async setEvent<TValue>(key: string, value: TValue): Promise<void> {
    const name = `event:${key}`;
    const seq = this.next('setEvent');
    const { found } = this.replay(seq, 'step', name);
    if (found) return;
    const at = Date.now();
    this.commands.push({
      kind: 'recordStep',
      seq,
      name,
      output: value,
      startedAt: at,
      finishedAt: at,
    });
  }

  /** UNSUPPORTED: update points are delivered + validated by the engine (`engine.update`). */
  async onUpdate<TArg>(_name: string, _opts?: { timeoutMs?: number }): Promise<TArg> {
    return this.unsupported('onUpdate');
  }

  /** UNSUPPORTED: patch markers need engine-side position rewind against the live checkpoint store. */
  async patched(_id: string): Promise<boolean> {
    return this.unsupported('patched');
  }
}
