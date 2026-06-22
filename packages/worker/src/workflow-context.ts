import type {
  HistoryEvent,
  StepError,
  StepEvent,
  WorkflowCommand,
  WorkflowStepEvent,
} from '@dudousxd/nestjs-durable-core';
import {
  Cancelled,
  GatherError,
  type GatherFailure,
  NondeterminismError,
  StepFailed,
  Suspend,
  toError,
} from './errors';

/** Mode for the parallel ops: `waitAll` records/awaits every item then aggregates failures;
 *  `failFast` surfaces the first failure as soon as it is seen. Mirrors Python `wait_all`/`fail_fast`. */
export type GatherMode = 'waitAll' | 'failFast';

/**
 * Minimal events sink handed to a `ctx.step` body so it can record sub-events (logs + sub-process
 * outcomes), captured onto the step's `recordStep` command. The TS twin of the Python SDK's
 * `StepContext.events`. Kept deliberately small — the full `StepLogger`/`subProcess` surface lives
 * in the engine; the thin worker only needs the recording sink.
 */
export interface StepLog {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** Record a sub-step / sub-process outcome (e.g. one of N parallel p-processes). */
  sub(name: string, status: 'ok' | 'failed' | 'skipped', message?: string, data?: unknown): void;
}

const LEVEL_FOR_STATUS = {
  ok: 'info',
  failed: 'error',
  skipped: 'warn',
} as const;

/** The body a `ctx.step` runs. Receives a {@link StepLog} sink; sync or async. */
export type StepBody<T> = (log: StepLog) => Promise<T> | T;

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
 */
export class WorkflowContext {
  /** New durable ops this turn produced, ordered by seq. */
  readonly commands: WorkflowCommand[] = [];

  private readonly history: Map<number, HistoryEvent>;
  private readonly signalsBySeq: Map<number, { seq: number; signal: string; payload: unknown }>;
  private readonly onStep: ((event: WorkflowStepEvent) => void) | undefined;
  private readonly isCancelled: ((runId: string) => boolean) | undefined;
  private seq = 0;

  constructor(
    readonly runId: string | undefined,
    history: HistoryEvent[],
    opts: WorkflowContextOptions = {},
  ) {
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
    if (
      this.isCancelled !== undefined &&
      this.runId !== undefined &&
      this.isCancelled(this.runId)
    ) {
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
        `history at seq ${seq} is ${ev.kind}/${JSON.stringify(ev.name)}, ` +
          `but replay reached ${kind}/${JSON.stringify(name)}`,
      );
    }
  }

  // -- the workflow API ----------------------------------------------------

  /** Dispatch a remote step (any-language worker in `group`) and await its result. Mirrors Python `call`. */
  async call<T = unknown>(name: string, input: unknown, opts: { group: string }): Promise<T> {
    const seq = this.next();
    const { found, output } = this.replay(seq, 'call', name);
    if (found) return output as T;
    this.commands.push({ kind: 'call', seq, name, group: opts.group, input });
    throw new Suspend();
  }

  /**
   * Run a LOCAL step once and record its result, so side effects / non-determinism happen exactly
   * once and replay returns the captured value. Mirrors Python `step`.
   */
  async step<T = unknown>(name: string, body: StepBody<T>): Promise<T> {
    const seq = this.next();
    const { found, output } = this.replay(seq, 'step', name);
    if (found) return output as T;

    const { output: result, error } = await this.runStepBody(seq, name, body);
    if (error !== undefined) throw new StepFailed(error);
    return result as T;
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
    const log = makeStepLog(events);
    const startedAt = Date.now();
    const runId = this.runId ?? '';
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

  /** Durably sleep `ms`; the run suspends and the engine resumes it when the timer fires. Mirrors Python `sleep`. */
  async sleep(ms: number): Promise<void> {
    const seq = this.next();
    const { found } = this.replay(seq, 'timer');
    if (found) return;
    this.commands.push({ kind: 'sleep', seq, ms });
    throw new Suspend();
  }

  /** Block until a signal `name` is delivered to this run; returns its payload. Mirrors Python `wait_signal`. */
  async waitSignal<T = unknown>(name: string): Promise<T> {
    const seq = this.next();
    const { found, output } = this.replay(seq, 'signal', name);
    if (found) return output as T;
    const sig = this.signalsBySeq.get(seq);
    if (sig !== undefined) return sig.payload as T;
    this.commands.push({ kind: 'waitSignal', seq, signal: name });
    throw new Suspend();
  }

  /** Start a child run and await its output (its own durable lifecycle). Mirrors Python `start_child`. */
  async startChild<T = unknown>(workflow: string, input: unknown): Promise<T> {
    const seq = this.next();
    const { found, output } = this.replay(seq, 'child', workflow);
    if (found) return output as T;
    this.commands.push({ kind: 'startChild', seq, workflow, input });
    throw new Suspend();
  }

  /**
   * Run N LOCAL step bodies CONCURRENTLY and wait for all (Node: `Promise` over the bodies, no
   * threads). Reserves a contiguous seq block in list order BEFORE running any body — the determinism
   * anchor, identical to a sequence of `step` calls, so replay reaches the same seqs regardless of
   * which body settles first. Records each outcome as a `recordStep` command in seq order, every one
   * tagged with the same `parallelGroup` (`gather:<firstSeq>`).
   *
   * `waitAll` (default): await all, record all, throw {@link GatherError} if any failed.
   * `failFast`: still records every started body's outcome, then throws {@link GatherError} carrying
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
      if (failures.length > 0) throw new GatherError(failures);
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
    if (failures.length > 0) throw new GatherError(failures);
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
   * `waitAll` (default): aggregate failures into {@link GatherError}. `failFast`: raise as soon as a
   * failed child is seen on a resume (siblings are not force-cancelled in v1). Empty inputs → `[]`.
   * Mirrors Python `gather_children`.
   */
  async all(
    workflow: string,
    inputs: unknown[],
    opts: { mode?: GatherMode } = {},
  ): Promise<unknown[]> {
    const entries = inputs.map((input, index) => ({
      index,
      seq: this.next(),
      input,
      history: undefined as HistoryEvent | null | undefined,
    }));
    const first = entries[0];
    if (first === undefined) return [];
    const group = `gather:${first.seq}`;
    for (const e of entries) e.history = this.replayEntry(e.seq, 'child', workflow);

    if ((opts.mode ?? 'waitAll') === 'failFast') {
      for (const e of entries) {
        if (e.history?.error != null) {
          throw new GatherError([{ index: e.index, workflow, error: e.history.error }]);
        }
      }
    }

    let pending = false;
    for (const e of entries) {
      if (e.history == null) {
        this.commands.push({
          kind: 'startChild',
          seq: e.seq,
          workflow,
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
        failures.push({ index: e.index, workflow, error: ev.error });
        return undefined;
      }
      return ev.output;
    });
    if (failures.length > 0) throw new GatherError(failures);
    return outputs;
  }
}

/** Build the minimal recording {@link StepLog} that appends each event to `events`. Shared with the
 *  {@link StepWorker} so a remote step handler records sub-events the same way an inline `ctx.step` does. */
export function makeStepLog(events: StepEvent[]): StepLog {
  const logLine = (level: StepEvent['level'], message: string, data?: unknown) => {
    const e: StepEvent = { at: Date.now(), level, message };
    if (data !== undefined) e.data = data;
    events.push(e);
  };
  return {
    debug: (m, d) => logLine('debug', m, d),
    info: (m, d) => logLine('info', m, d),
    warn: (m, d) => logLine('warn', m, d),
    error: (m, d) => logLine('error', m, d),
    sub: (name, status, message, data) => {
      const e: StepEvent = {
        at: Date.now(),
        level: LEVEL_FOR_STATUS[status],
        message: message ?? name,
        name,
        status,
      };
      if (data !== undefined) e.data = data;
      events.push(e);
    },
  };
}
