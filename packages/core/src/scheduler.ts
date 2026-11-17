import { createRequire } from 'node:module';
import { resolveCronParse } from './cron-compat';
import type { WorkflowEngine } from './engine';
import { type RunStatus, TERMINAL_RUN_STATUSES } from './interfaces';
import { type WorkflowInputOf, type WorkflowRef, workflowName } from './workflow-ref';

// Resolve the optional `cron-parser` peer dependency in a way that works in BOTH the ESM and CJS
// builds of this package (dual publish). `createRequire(import.meta.url)` gives a real `require` in
// ESM output; in the CJS build, tsup's banner shims `import.meta.url` to the file URL, so the same
// call resolves there too. This keeps the load synchronous (no async leak into the scheduler API).
const nodeRequire = createRequire(import.meta.url);

/**
 * A recurring start of `workflow`, fired on a fixed interval or a cron.
 *
 * `workflow` is a registered name or a `@Workflow` class. A class types `input` against its `run`;
 * annotate the schedule to get that check, as in
 * `const nightly: ScheduledWorkflow<typeof ReportWorkflow> = { workflow: ReportWorkflow, … }`.
 */
export interface ScheduledWorkflow<W extends WorkflowRef = WorkflowRef> {
  /** Stable key identifying this schedule — part of the deterministic run id. */
  key: string;
  /** The workflow to start: a registered name (any runtime) or a `@Workflow` class. */
  workflow: W;
  /** The input every run starts with — typed against `run` when `workflow` is a class. */
  input?: WorkflowInputOf<W>;
  /** Start one run every `everyMs`. Mutually exclusive with `cron`. */
  everyMs?: number;
  /**
   * A cron expression (5 fields `m h dom mon dow`, or 6 with leading seconds) evaluated in
   * {@link ScheduledWorkflow.timezone}. Mutually exclusive with `everyMs`. Needs the optional peer
   * dependency `cron-parser`.
   */
  cron?: string;
  /** IANA timezone the `cron` fires in (e.g. `America/Sao_Paulo`). Defaults to UTC. */
  timezone?: string;
  /** Temporarily stop firing this schedule (kept registered). Defaults to false. */
  paused?: boolean;
  /**
   * What to do when an earlier window's run hasn't finished yet (interval and cron schedules alike):
   * `'allow'` (default) starts the new window anyway; `'skip'` skips every window while any earlier
   * run of this schedule is still in flight (pending, running, suspended, blocked or cancelling), so a
   * slow run can't pile up overlapping executions. With `backfill`, missed windows start one at a
   * time.
   */
  overlap?: 'allow' | 'skip';
  /**
   * Randomly delay the dispatch by up to this many ms BEFORE firing, to spread load when many
   * instances tick on the same boundary (avoids a thundering herd). Opt-in; absent = fire immediately.
   * The window is deferred to a later tick, never waited for inside one, so a jittered schedule does
   * not hold up any other schedule or the rest of the timer poll.
   *
   * This is dispatch-path jitter only — it does NOT affect the run id (still the time bucket), so
   * idempotency is unchanged: two instances jittering the same window still start it exactly once.
   * (The engine forbids `Math.random` inside workflow code; the scheduler dispatch path is not
   * workflow code, so jitter here is fine.)
   */
  jitter?: number;
  /**
   * Enqueue windows that were missed while the scheduler was down, instead of silently skipping
   * them. Opt-in; absent = only the current window fires. `maxCatchup` bounds how many PRIOR windows
   * are backfilled (a long outage can't flood the system). Backfilled runs use each missed window's
   * deterministic bucket run id, so `engine.start` idempotency skips any that already ran.
   */
  backfill?: { maxCatchup: number };
  /**
   * The namespace this schedule's runs are stamped with, overriding the ticking engine's own. Opt-in;
   * absent = the run gets the namespace of whichever engine fired it.
   *
   * The run id is a time bucket, so the instance that wins the race to fire a window decides which
   * namespace (worker pool) the run lands in. When the workflow can only run in one pool — its steps
   * need a capability only that pool's workers have — pin it here, so whoever fires the window, the
   * run is stamped for (and only picked up by) that pool.
   */
  namespace?: string;
}

/** Injectable dispatch-path effects (kept out of the deterministic run-id logic). Defaults to real
 *  `Math.random`; overridden in tests so jitter is deterministic. */
export interface RunSchedulesOptions {
  random?: () => number;
}

/** Per engine, per schedule key: the jittered fire time of each window this process has seen due. */
const jitterFireAt = new WeakMap<object, Map<string, Map<string, number>>>();

/** Windows of `key` an earlier tick deferred for jitter and that have not fired yet. */
function deferredWindows(engine: object, key: string): string[] {
  return [...(jitterFireAt.get(engine)?.get(key)?.keys() ?? [])];
}

/**
 * The candidate windows whose jittered fire time has arrived. A window first seen due gets
 * `now + random() * jitter`, kept until it fires, so the delay is drawn once per window per process
 * (instances still draw independently and the earliest one wins, as before). Only the current
 * candidates are kept for a key, so a window that fired (here or on another instance) is dropped,
 * not leaked.
 */
function jitterDue(
  engine: object,
  s: ScheduledWorkflow,
  candidates: string[],
  nowMs: number,
  random: () => number,
): string[] {
  let byKey = jitterFireAt.get(engine);
  if (byKey === undefined) {
    byKey = new Map();
    jitterFireAt.set(engine, byKey);
  }
  const previous = byKey.get(s.key);
  const current = new Map<string, number>();
  const due: string[] = [];
  for (const runId of candidates) {
    const at = previous?.get(runId) ?? nowMs + Math.floor(random() * (s.jitter as number));
    if (nowMs >= at) due.push(runId);
    else current.set(runId, at);
  }
  byKey.set(s.key, current);
  return due;
}

/**
 * The earliest time after `nowMs` at which {@link runSchedules} may have a window of `schedules` to
 * fire for `engine`: each unpaused schedule's next window boundary, and the fire time of any jittered
 * window an earlier call deferred. `nowMs` when a schedule cannot say (an unparsable cron, a missing
 * `cron-parser`), so a caller never waits past a window; `undefined` for none. Pass the same `engine`
 * object as to `runSchedules` (the deferred windows are remembered per engine object).
 */
export function nextScheduleFireAt(
  engine: object,
  schedules: readonly ScheduledWorkflow[],
  nowMs: number,
): number | undefined {
  let next: number | undefined;
  const consider = (at: number) => {
    if (next === undefined || at < next) next = at;
  };
  for (const s of schedules) {
    for (const at of jitterFireAt.get(engine)?.get(s.key)?.values() ?? []) consider(at);
    if (s.paused) continue;
    try {
      if (s.cron != null) consider(nextCronFireMs(s.cron, nowMs, s.timezone));
      else if (s.everyMs != null && s.everyMs > 0)
        consider((Math.floor(nowMs / s.everyMs) + 1) * s.everyMs);
      else return nowMs;
    } catch {
      return nowMs;
    }
  }
  return next;
}

/** Deterministic run id for a fixed-interval schedule's current time window. */
export function scheduledRunId(key: string, everyMs: number, nowMs: number): string {
  return `sched:${key}:${Math.floor(nowMs / everyMs)}`;
}

let cronParser: unknown;
function loadCronParser(): unknown {
  if (cronParser !== undefined) return cronParser;
  try {
    // Lazy + optional: core stays dependency-free; only users who schedule by cron need this.
    cronParser = nodeRequire('cron-parser');
  } catch {
    throw new Error(
      'cron schedules need the optional peer dependency "cron-parser" — install it (e.g. `npm i cron-parser`).',
    );
  }
  return cronParser;
}

/**
 * Epoch ms of the most recent cron fire at or before `nowMs`, evaluated in `timezone` (default UTC).
 * This is the deterministic "bucket" a cron run is keyed on, so polling repeatedly within an
 * interval resolves to the same fire time — and thus the same idempotent run id.
 */
export function prevCronFireMs(expr: string, nowMs: number, timezone = 'UTC'): number {
  const parse = resolveCronParse(loadCronParser());
  if (!parse) {
    throw new Error(
      'the installed "cron-parser" exposes neither v4\'s parseExpression nor v5\'s CronExpressionParser.parse — the supported range is ^4.0.0 || ^5.0.0.',
    );
  }
  // `+1` makes a fire landing exactly on `nowMs` count as "at or before now", not the prior one.
  return parse(expr, { currentDate: new Date(nowMs + 1), tz: timezone })
    .prev()
    .toDate()
    .getTime();
}

/**
 * Epoch ms of the first cron fire STRICTLY after `afterMs`, evaluated in `timezone` (default UTC) —
 * the forward counterpart of {@link prevCronFireMs}, used by persisted schedules to compute when a
 * schedule is next due.
 */
export function nextCronFireMs(expr: string, afterMs: number, timezone = 'UTC'): number {
  const parse = resolveCronParse(loadCronParser());
  if (!parse) {
    throw new Error(
      'the installed "cron-parser" exposes neither v4\'s parseExpression nor v5\'s CronExpressionParser.parse — the supported range is ^4.0.0 || ^5.0.0.',
    );
  }
  return parse(expr, { currentDate: new Date(afterMs), tz: timezone })
    .next()
    .toDate()
    .getTime();
}

/**
 * The deterministic, idempotent run id for a schedule at `nowMs` — its current fire window
 * (`sched:<key>:<bucket>`, the bucket being a fixed-interval index or the cron fire time). Pass the
 * same `ScheduledWorkflow` you registered to look a window's run up, e.g.
 * `engine.getRun(scheduleRunIdAt(dailyReport, Date.now()))`, rather than rebuilding the id by hand.
 */
export function scheduleRunIdAt(s: ScheduledWorkflow, nowMs: number): string {
  if (s.cron != null) return `sched:${s.key}:${prevCronFireMs(s.cron, nowMs, s.timezone)}`;
  if (s.everyMs != null) return scheduledRunId(s.key, s.everyMs, nowMs);
  throw new Error(`schedule "${s.key}" needs either "everyMs" or "cron"`);
}

/**
 * The run ids this schedule should fire at `nowMs`: the current window, plus — when `backfill` is set
 * — up to `maxCatchup` prior windows that may have been missed. Oldest-first, so a backfill catches
 * up in chronological order. Ids are the same deterministic buckets `scheduleRunIdAt` produces, so
 * `engine.start` idempotency drops any window that already ran.
 */
function scheduleRunIdsAt(s: ScheduledWorkflow, nowMs: number): string[] {
  const current = scheduleRunIdAt(s, nowMs);
  if (!s.backfill || s.backfill.maxCatchup <= 0) return [current];

  const ids: string[] = [];
  if (s.everyMs != null) {
    const bucket = Math.floor(nowMs / s.everyMs);
    const oldest = Math.max(0, bucket - s.backfill.maxCatchup);
    for (let b = oldest; b < bucket; b += 1) ids.push(`sched:${s.key}:${b}`);
  } else if (s.cron != null) {
    // Walk back through prior cron fire times (most-recent missed first), then reverse to oldest-first.
    const prior: string[] = [];
    let cursor = prevCronFireMs(s.cron, nowMs, s.timezone);
    for (let i = 0; i < s.backfill.maxCatchup; i += 1) {
      // `cursor` (exclusive) → the fire strictly before it.
      const before = prevCronFireMs(s.cron, cursor - 1, s.timezone);
      prior.push(`sched:${s.key}:${before}`);
      cursor = before;
    }
    ids.push(...prior.reverse());
  }
  ids.push(current);
  return ids;
}

/**
 * Start each schedule's current-window run. The run id is the time bucket (a fixed-interval index,
 * or the cron fire time) and `engine.start` is idempotent, so firing this on an interval — or
 * racing two instances on the same tick — starts **each window exactly once**. Wire it to a
 * `setInterval`, the durable timer poller, or `@nestjs/schedule`.
 *
 * Pass the SAME `engine` object on every call: which windows already fired, and the jittered fire
 * time of each deferred window, are remembered per engine object. A fresh wrapper per call would
 * redraw a deferred window's fire time on every tick, so it might never fire. Returns the run ids this call
 * started: a window that already has a run is not started or returned again, and once this process
 * has seen a window's run exist, later calls in that window skip it without a store read. A
 * jittered window is deferred to a later call, never slept on.
 */
export async function runSchedules(
  engine: ScheduleTickEngine,
  schedules: readonly ScheduledWorkflow[],
  nowMs: number,
  opts?: RunSchedulesOptions,
): Promise<string[]> {
  const random = opts?.random ?? Math.random;
  const settled = settledIdsFor(engine);
  const ids: string[] = [];
  for (const s of schedules) {
    if (engine.isDraining?.()) break; // shutting down: fire no further windows
    if (s.paused) continue;

    // The windows that might still need firing: every one this process has not already seen exist.
    // A run id is derived from the window's fire time, so it is CONSTANT for the whole window, and
    // asking the store about it again on the next tick can only produce the answer already got.
    // See {@link settledIdsFor}.
    // A jittered window deferred by an earlier tick stays a candidate until it fires, even once the
    // schedule has moved on to the next window (a jitter longer than the interval).
    const due = scheduleRunIdsAt(s, nowMs);
    const windows =
      s.jitter && s.jitter > 0 ? [...new Set([...deferredWindows(engine, s.key), ...due])] : due;
    const candidates = windows.filter((id) => !settled.get(s.key)?.has(id));
    // Nothing to do this tick, and no I/O to prove it — nor a jitter sleep: a schedule whose window
    // already fired used to sleep up to `jitter` ms on EVERY tick, stalling the whole timer poll
    // (due timers, retries, timeouts) behind it.
    if (candidates.length === 0) continue;

    // overlap:'skip': no new window while ANY earlier run of this schedule is still in flight —
    // cron or interval alike. Checked after the candidate filter: it only matters when something is
    // about to start, so an idle schedule still costs no I/O per tick.
    if (s.overlap === 'skip' && (await overlapping(engine, s, nowMs))) continue;
    // Dispatch-path jitter (not workflow code): spread same-boundary ticks across instances. Each
    // window gets its own fire time, `jitter` at most after this process first saw it due, and is
    // skipped until then — the tick does NOT sleep. Sleeping here held the whole timer poll (every
    // other schedule, due timers, retries, timeouts) for the jitter of every due schedule in turn:
    // after a restart, with a few windows due at once, schedules fired many minutes late. The run
    // ids below are unaffected, so idempotency holds.
    if (!(s.jitter && s.jitter > 0)) jitterFireAt.get(engine)?.delete(s.key); // jitter removed
    const firing =
      s.jitter && s.jitter > 0 ? jitterDue(engine, s, candidates, nowMs, random) : candidates;
    if (firing.length === 0) continue;
    for (const runId of firing) {
      if (engine.isDraining?.()) break; // drain began during an await
      // Only fire (and report) windows that don't exist yet. `start` is idempotent by run id anyway,
      // but reporting its no-op re-ticks made every tick return the current window's id for the rest
      // of the window. Two instances racing on the same boundary can both get here; `start`'s
      // idempotency keeps it to one run — only the returned ids may briefly overcount.
      const existing = await engine.getRun(runId);
      remember(settled, s.key, runId);
      if (existing) {
        if (s.overlap === 'skip' && !isTerminal(existing.status)) {
          // Another instance (or a manual trigger) started it: it is the run to wait on now.
          noteInFlight(engine, s.key, runId);
          break;
        }
        continue;
      }
      await engine.start(workflowName(s.workflow), s.input, runId, { namespace: s.namespace });
      ids.push(runId);
      if (s.overlap === 'skip') {
        // The run just started overlaps every later window, so a backfill under 'skip' catches up
        // one window at a time instead of starting them all at once.
        noteInFlight(engine, s.key, runId);
        break;
      }
    }
  }
  return ids;
}

/**
 * What {@link runSchedules} needs from the engine. `listRuns` is what lets `overlap: 'skip'` find an
 * in-flight run this process never saw (started before a restart, or by another instance); a driver
 * without it only sees the runs it observed itself plus the previous window.
 */
export type ScheduleTickEngine = Pick<WorkflowEngine, 'start' | 'getRun'> &
  Partial<Pick<WorkflowEngine, 'isDraining' | 'listRuns'>>;

/** Every status a run can still leave: what "still in flight" means for `overlap: 'skip'`. */
const IN_FLIGHT: RunStatus[] = ['pending', 'running', 'suspended', 'blocked', 'cancelling'];

function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Per engine, per schedule key: run ids of this schedule last known to be in flight. Only an
 * optimization; the store stays the source of truth (see {@link overlapping}). Bounded: an id leaves
 * as soon as a read shows it settled, and the set is capped.
 */
const inFlightRuns = new WeakMap<object, Map<string, Set<string>>>();

function inFlightFor(engine: object, key: string): Set<string> {
  let byKey = inFlightRuns.get(engine);
  if (byKey === undefined) {
    byKey = new Map();
    inFlightRuns.set(engine, byKey);
  }
  let ids = byKey.get(key);
  if (ids === undefined) {
    ids = new Set();
    byKey.set(key, ids);
  }
  return ids;
}

function noteInFlight(engine: object, key: string, runId: string): void {
  const ids = inFlightFor(engine, key);
  ids.add(runId);
  // Each id leaves once seen settled; the cap only guards against a pathological pile-up.
  if (ids.size > 64) ids.delete(ids.values().next().value as string);
}

/**
 * Whether an earlier run of schedule `s` is still in flight, so `overlap: 'skip'` must hold this
 * window back.
 *
 * Checking only the previous window's id is not enough: while window N runs, N+1 is skipped and
 * never gets a run, so at N+2 "the previous window" is empty and a second run would start next to
 * N. So:
 *
 * 1. Runs this process already knows are in flight are re-read by id (newest first, stopping at the
 *    first still in flight). While a long run blocks the schedule that is ONE read per tick.
 * 2. Once none of them is in flight any more, the store is asked once for this schedule's in-flight
 *    runs (`listRuns` by workflow + in-flight statuses, filtered to `sched:<key>:` ids). That covers
 *    what the memo can't know: runs from before a restart, runs another instance started,
 *    backfilled windows. It happens once per window that is about to start, never on an idle tick,
 *    and has no look-back bound, so a run stuck for days still blocks, cron or interval alike.
 */
async function overlapping(
  engine: ScheduleTickEngine,
  s: ScheduledWorkflow,
  nowMs: number,
): Promise<boolean> {
  const known = inFlightFor(engine, s.key);
  for (const runId of [...known].reverse()) {
    const run = await engine.getRun(runId);
    if (run && !isTerminal(run.status)) return true;
    known.delete(runId);
  }

  if (engine.listRuns) {
    const prefix = `sched:${s.key}:`;
    const runs = await engine.listRuns({ workflow: workflowName(s.workflow), statuses: IN_FLIGHT });
    const blocking = runs.filter((r) => r.id.startsWith(prefix) && !isTerminal(r.status));
    for (const r of blocking) noteInFlight(engine, s.key, r.id);
    return blocking.length > 0;
  }

  // A driver without `listRuns`: the most it can check beyond its own memo is the window just
  // before the current one.
  const prev = previousWindowRunId(s, nowMs);
  if (prev === undefined) return false;
  const run = await engine.getRun(prev);
  if (!run || isTerminal(run.status)) return false;
  noteInFlight(engine, s.key, prev);
  return true;
}

/** The run id of the window before the one current at `nowMs` (interval bucket or cron fire). */
function previousWindowRunId(s: ScheduledWorkflow, nowMs: number): string | undefined {
  if (s.cron != null) {
    const current = prevCronFireMs(s.cron, nowMs, s.timezone);
    return `sched:${s.key}:${prevCronFireMs(s.cron, current - 1, s.timezone)}`;
  }
  if (s.everyMs != null) {
    const bucket = Math.floor(nowMs / s.everyMs) - 1;
    return bucket >= 0 ? `sched:${s.key}:${bucket}` : undefined;
  }
  return undefined;
}

/**
 * Per-engine memo of run ids this process has already seen exist in the store.
 *
 * A schedule's run id is the id of its fire WINDOW, so within a window it never changes. Once a tick
 * has learned that id exists, every later tick in the same window would ask the store a question
 * whose answer cannot have changed, and pay a round trip (and the schedule's jitter) for it.
 *
 * Idempotency is untouched: the memo only skips work this process KNOWS already happened. It is never
 * consulted for an id this process has not observed, so a fresh process, and the first tick of every
 * new window, still go to the store — which is where the cross-instance race is decided.
 *
 * Bounded: only the current window's ids per schedule key are kept. A WeakMap keyed by the engine, so
 * two engines in one process (tests, multi-tenant hosts) never share it, and it goes with the engine.
 */
const settledRunIds = new WeakMap<object, Map<string, Set<string>>>();

function settledIdsFor(engine: object): Map<string, Set<string>> {
  let memo = settledRunIds.get(engine);
  if (memo === undefined) {
    memo = new Map();
    settledRunIds.set(engine, memo);
  }
  return memo;
}

/** Record `runId` as known to exist, dropping older windows' ids for that key. */
function remember(memo: Map<string, Set<string>>, key: string, runId: string): void {
  const seen = memo.get(key);
  if (seen === undefined) {
    memo.set(key, new Set([runId]));
    return;
  }
  // A backfill tick settles several ids at once, so keep this pass's ids together; a set past any
  // sane backfill span (a schedule reconfigured at runtime) starts over from this id.
  seen.add(runId);
  if (seen.size > 64) memo.set(key, new Set([runId]));
}
