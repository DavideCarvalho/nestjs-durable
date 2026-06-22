import type {
  HistoryEvent,
  StepEvent,
  WorkflowCommand,
  WorkflowStepEvent,
} from '@dudousxd/nestjs-durable-core';
import { Cancelled, NondeterminismError, StepFailed, Suspend, toError } from './errors';

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

    const events: StepEvent[] = [];
    const log = makeStepLog(events);
    const startedAt = Date.now();
    this.emitStep({ runId: this.runId ?? '', seq, name, phase: 'running', startedAt });

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
      this.commands.push(cmd);
      this.emitStep({
        runId: this.runId ?? '',
        seq,
        name,
        phase: 'completed',
        startedAt,
        finishedAt,
        output: result,
        events,
      });
      return result;
    } catch (err) {
      const error = toError(err);
      const finishedAt = Date.now();
      const cmd: WorkflowCommand = { kind: 'recordStep', seq, name, error, startedAt, finishedAt };
      if (events.length > 0) cmd.events = events;
      this.commands.push(cmd);
      this.emitStep({
        runId: this.runId ?? '',
        seq,
        name,
        phase: 'failed',
        startedAt,
        finishedAt,
        error,
        events,
      });
      throw new StepFailed(error);
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
}

/** Build the minimal recording {@link StepLog} that appends each event to `events`. */
function makeStepLog(events: StepEvent[]): StepLog {
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
