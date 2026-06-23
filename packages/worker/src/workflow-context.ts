import type {
  ChildCallOptions,
  DurableWebhook,
  HistoryEvent,
  RemoteStepDef,
  StepError,
  StepEvent,
  StepLogger,
  StepOptions,
  WorkflowClass,
  WorkflowCommand,
  WorkflowCtx,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowRef,
  WorkflowStepEvent,
} from '@dudousxd/nestjs-durable-core';
import { createStepLogger, parseDuration, workflowName } from '@dudousxd/nestjs-durable-core';
import {
  Cancelled,
  type GatherFailure,
  GatherReplayError,
  NondeterminismError,
  StepFailed,
  Suspend,
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
}

/**
 * The replay context handed to a workflow function. Its ops are deterministic: same code + same
 * history ⇒ same seqs ⇒ same decisions. A faithful port of the Python `durable_worker` `WorkflowContext`:
 * history in → commands out, suspend by throwing {@link Suspend}.
 *
 * It `implements` the engine's {@link WorkflowCtx}, so a NestJS `@Workflow` body typed against
 * `WorkflowCtx` runs UNCHANGED on the thin worker. The API splits in two:
 *
 * - **Supported** (wire-expressible) — {@link step}, {@link call}, {@link sleep},
 *   {@link waitForSignal}, {@link child}, {@link all}, {@link now}/{@link random}/{@link uuid}: each
 *   maps to a {@link WorkflowCommand} (`call`/`recordStep`/`sleep`/`waitSignal`/`startChild`) the
 *   engine applies durably.
 * - **Unsupported** — `transaction`, `callEntity`, `signalEntity`, `continueAsNew`, `sleepUntil`,
 *   `waitForEvent`, `task`, `startChild` (fire-and-forget), `breakpoint`, `webhook`, `setEvent`,
 *   `onUpdate`, `patched`: they need engine/store/transport features the remote wire can't express,
 *   so each throws {@link UnsupportedOnThinWorker} (run such a workflow in-process on the engine).
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
  private seq = 0;

  constructor(runId: string, history: HistoryEvent[], opts: WorkflowContextOptions = {}) {
    this.runId = runId;
    this.history = new Map(history.map((e) => [e.seq, e]));
    this.signalsBySeq = new Map((opts.pendingSignals ?? []).map((s) => [s.seq, s]));
    this.onStep = opts.onStep;
    this.isCancelled = opts.isCancelled;
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
  private next(): number {
    this.raiseIfCancelled();
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
   * Dispatch a typed remote step (any-language worker in its `group`) and await its result. The
   * engine's `ctx.call` takes a {@link RemoteStepDef} (not a name): we read its `name`/`group` and
   * emit the wire `call` command. `opts` (`queue`/`priority`/`fairnessKey`/`transport`) are
   * engine-side ADMISSION concerns — accepted for `WorkflowCtx` conformance, but the remote wire
   * has no place for them, so they don't change the worker's emitted command. Mirrors Python `call`.
   */
  async call<TInput, TOutput>(
    step: RemoteStepDef<TInput, TOutput>,
    input: TInput,
    _opts?: { queue?: string; priority?: number; fairnessKey?: string; transport?: string },
  ): Promise<TOutput> {
    const seq = this.next();
    const { found, output } = this.replay(seq, 'call', step.name);
    if (found) return output as TOutput;
    this.commands.push({ kind: 'call', seq, name: step.name, group: step.group, input });
    throw new Suspend();
  }

  /**
   * Run a LOCAL step once and record its result, so side effects / non-determinism happen exactly
   * once and replay returns the captured value. The body receives a {@link StepLogger}. `options`
   * (retries/backoff/compensate) are engine-side concerns the thin worker doesn't apply — accepted
   * for `WorkflowCtx` conformance, ignored on the wire. Mirrors Python `step`.
   *
   * **WARNING — silently ignored options:** `options.retries`, `options.backoff`, and
   * `options.compensate` are **silently ignored** on the thin worker: no retry loop runs and no
   * saga compensation is registered. A portable workflow body that depends on retry behaviour or
   * compensation MUST run in-process on the engine instead of on the thin worker, otherwise those
   * guarantees are simply absent with no error raised.
   */
  async step<TOutput>(
    name: string,
    fn: (log: StepLogger) => Promise<TOutput> | TOutput,
    _options?: StepOptions,
  ): Promise<TOutput> {
    const seq = this.next();
    const { found, output } = this.replay(seq, 'step', name);
    if (found) return output as TOutput;

    const { output: result, error } = await this.runStepBody(seq, name, fn);
    if (error !== undefined) throw new StepFailed(error);
    return result as TOutput;
  }

  /**
   * Run one local step body, record its `recordStep` command (with `parallelGroup` when set) and
   * stream its lifecycle. Returns `{output}` on success or `{error}` on failure WITHOUT throwing, so
   * {@link step} and {@link gather} can decide how to surface it. The single place a local step's
   * side effects + recording happen exactly once.
   */
  private async runStepBody(
    seq: number,
    name: string,
    body: StepBody<unknown>,
    parallelGroup?: string,
  ): Promise<{ output?: unknown; error?: StepError; events: StepEvent[] }> {
    const events: StepEvent[] = [];
    const log = createStepLogger(events, () => Date.now());
    const startedAt = Date.now();
    const runId = this.runId;
    this.emitStep({ runId, seq, name, phase: 'running', startedAt, parallelGroup });

    try {
      const result = await body(log);
      const finishedAt = Date.now();
      const cmd: WorkflowCommand = {
        kind: 'recordStep',
        seq,
        name,
        output: result,
        startedAt,
        finishedAt,
      };
      if (events.length > 0) cmd.events = events;
      if (parallelGroup !== undefined) cmd.parallelGroup = parallelGroup;
      this.commands.push(cmd);
      this.emitStep({
        runId,
        seq,
        name,
        phase: 'completed',
        startedAt,
        finishedAt,
        output: result,
        events,
        parallelGroup,
      });
      return { output: result, events };
    } catch (err) {
      const error = toError(err);
      const finishedAt = Date.now();
      const cmd: WorkflowCommand = { kind: 'recordStep', seq, name, error, startedAt, finishedAt };
      if (events.length > 0) cmd.events = events;
      if (parallelGroup !== undefined) cmd.parallelGroup = parallelGroup;
      this.commands.push(cmd);
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
  }

  /**
   * Durable sleep: suspends the run for `duration` (e.g. `'30s'`, `'2h'`, or ms as a number); the
   * engine resumes it when the timer fires. The duration is parsed to ms HERE (`parseDuration`) and
   * the engine computes the absolute deadline when it applies the `sleep` command. Mirrors Python
   * `sleep` and matches `WorkflowCtx.sleep`.
   */
  async sleep(duration: string | number): Promise<void> {
    const seq = this.next();
    const { found } = this.replay(seq, 'timer');
    if (found) return;
    this.commands.push({ kind: 'sleep', seq, ms: parseDuration(duration) });
    throw new Suspend();
  }

  /**
   * Suspend until an external signal `token` is delivered to this run, then resume with its payload.
   * Mirrors Python `wait_signal`; renamed from the old `waitSignal` to match `WorkflowCtx.waitForSignal`.
   *
   * **Unbounded** (`waitForSignal(token)` / no `timeoutMs`) works correctly on the thin worker:
   * it consumes exactly ONE seq and emits a `waitSignal` command.
   *
   * **Bounded** (`opts.timeoutMs` set) throws {@link UnsupportedOnThinWorker} for two reasons:
   * (a) The thin worker owns no timers — it cannot honour a deadline remotely.
   * (b) The engine's bounded path consumes TWO seqs (a deadline seq + a wait seq), whereas the
   *     worker's unbounded path consumes ONE. Silently proceeding would break seq parity when a
   *     workflow is checkpointed on one runtime and resumed on the other, causing silent history
   *     mis-alignment. Run such a workflow in-process on the engine instead.
   */
  async waitForSignal<TPayload>(token: string, opts?: { timeoutMs?: number }): Promise<TPayload> {
    if (opts?.timeoutMs != null) {
      return this.unsupported('waitForSignal with timeoutMs');
    }
    const seq = this.next();
    const { found, output } = this.replay(seq, 'signal', token);
    if (found) return output as TPayload;
    const sig = this.signalsBySeq.get(seq);
    if (sig !== undefined) return sig.payload as TPayload;
    this.commands.push({ kind: 'waitSignal', seq, signal: token });
    throw new Suspend();
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
    const seq = this.next();
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
    const entries = items.map(([name, body], index) => ({ index, seq: this.next(), name, body }));
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
    const name = workflowName(workflow);
    const entries = inputs.map((input, index) => ({
      index,
      seq: this.next(),
      input,
      history: undefined as HistoryEvent | null | undefined,
    }));
    const first = entries[0];
    if (first === undefined) return [];
    const group = `gather:${first.seq}`;
    for (const e of entries) e.history = this.replayEntry(e.seq, 'child', name);

    if ((opts.mode ?? 'waitAll') === 'failFast') {
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

    const failures: GatherFailure[] = [];
    const outputs = entries.map((e) => {
      const ev = e.history as HistoryEvent;
      if (ev.error != null) {
        failures.push({ index: e.index, workflow: name, error: ev.error });
        return undefined;
      }
      return ev.output;
    });
    if (failures.length > 0) throw new GatherReplayError(failures);
    return outputs;
  }

  // -- deterministic sources (recorded once, replayed) ---------------------

  /**
   * Deterministic wall-clock (epoch ms): recorded as a `now` step on the first run and replayed
   * verbatim. Implemented as a recorded {@link step} exactly like the engine's ctx. Matches
   * `WorkflowCtx.now`.
   */
  now(): Promise<number> {
    return this.step('now', async () => Date.now());
  }

  /**
   * Deterministic random in `[0, 1)`: recorded as a `random` step once, then replayed. Implemented
   * as a recorded {@link step} like the engine's ctx. Matches `WorkflowCtx.random`.
   */
  random(): Promise<number> {
    return this.step('random', async () => Math.random());
  }

  /** Deterministic UUID v4: recorded as a `uuid` step once, then replayed. Matches `WorkflowCtx.uuid`. */
  uuid(): Promise<string> {
    return this.step('uuid', async () => globalThis.crypto.randomUUID());
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

  /** UNSUPPORTED: continue-as-new is an engine lifecycle op (resets history, mints `<runId>~N`). */
  async continueAsNew(_input?: unknown): Promise<never> {
    return this.unsupported('continueAsNew');
  }

  /** UNSUPPORTED: absolute-deadline timers aren't expressible on the `sleep` (ms-duration) wire op. */
  async sleepUntil(_when: Date | number): Promise<void> {
    return this.unsupported('sleepUntil');
  }

  /** UNSUPPORTED: named event pub/sub (`engine.publishEvent`) is an engine/store feature. */
  async waitForEvent<TPayload>(
    _name: string,
    _opts?: { match?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<TPayload> {
    return this.unsupported('waitForEvent');
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
   * UNSUPPORTED: fire-and-forget child. The remote wire's `startChild` command is the AWAIT-a-child
   * setup the engine resolves (see {@link child}); a non-suspending fire-forget that returns the
   * child run id immediately isn't expressible remotely yet.
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
    _workflow: WorkflowRef,
    _input: unknown,
    _options?: string | ChildCallOptions,
  ): Promise<string> {
    return this.unsupported('startChild');
  }

  /** UNSUPPORTED: a breakpoint records a visible `pending` checkpoint the engine resumes. */
  async breakpoint(_label?: string): Promise<void> {
    return this.unsupported('breakpoint');
  }

  /** UNSUPPORTED: minting a durable webhook needs the engine's `webhookUrl` builder + signal store. */
  webhook<TPayload>(): DurableWebhook<TPayload> {
    return this.unsupported('webhook');
  }

  /** UNSUPPORTED: a queryable named value is read externally via `engine.getEvent` (store-backed). */
  async setEvent<TValue>(_key: string, _value: TValue): Promise<void> {
    return this.unsupported('setEvent');
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
