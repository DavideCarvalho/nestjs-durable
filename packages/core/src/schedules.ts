import type { ConcurrencyQuota } from './concurrency';
import { parseDuration } from './duration';
import type { StartOptions } from './engine';
import { type AnnouncedSchedule, stableJson } from './handshake/descriptor';
import type {
  RunResult,
  RunStatus,
  ScheduleQuery,
  ScheduleRecord,
  SearchAttributes,
  StateStore,
  WorkflowRun,
} from './interfaces';
import { TERMINAL_RUN_STATUSES } from './interfaces';
import { nextRRuleFireMs, parseRRule, prevRRuleFireMs } from './rrule';
import { nextCronFireMs, prevCronFireMs } from './scheduler';
import {
  type RunTenant,
  type TenantFilter,
  inheritTenant,
  scopeTenantQuery,
  tenantVisible,
} from './tenancy';
import { type WorkflowRef, workflowName } from './workflow-ref';

/**
 * A schedule definition — what `engine.schedules.create/upsert` take. Temporal-style: a persisted,
 * runtime-managed recurring start of `workflow` with `input`, fired by every driving engine's timer
 * poll (safe with many workers: each window's run id is deterministic, `start` is idempotent, and
 * advancing the schedule is a compare-and-set).
 */
export interface ScheduleOptions {
  /** Stable id, unique per store (e.g. `digest:user-42`). Part of every run id it starts. */
  id: string;
  /** The workflow to start — a registered name or `@Workflow` class. */
  workflow: WorkflowRef;
  /** The input every run starts with. */
  input?: unknown;
  /** Cron expression (5 fields, or 6 with leading seconds). Needs the `cron-parser` peer. */
  cron?: string | undefined;
  /** Fixed interval (`'15m'`, or ms), windows aligned to the epoch. Exclusive with `cron`. */
  every?: string | number | undefined;
  /**
   * An RFC 5545 recurrence rule (`'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8'`, optionally with a
   * `DTSTART:…` line), evaluated in `timezone`. Exactly one of `cron`, `every` and `rrule`. See
   * {@link parseRRule} for the supported parts. No peer needed.
   */
  rrule?: string | undefined;
  /** IANA timezone the cron / rrule is evaluated in (e.g. `America/Sao_Paulo`). Default UTC. */
  timezone?: string | undefined;
  /**
   * Delay each fire by up to this much (`'30s'` or ms) — a stable per-(schedule, window) offset, so
   * thousands of schedules on the same cron don't all start in the same second.
   */
  jitter?: string | number | undefined;
  /**
   * The previous run of this schedule is still in flight when the next window comes due:
   * `'allow'` (default) starts the new one anyway; `'skip'` skips that window.
   */
  overlap?: 'allow' | 'skip' | undefined;
  /**
   * Windows missed while nothing polled (all schedulers down): `'latest'` (default) fires the most
   * recent missed window once; `'skip'` drops them and waits for the next window. Never more than one
   * catch-up run per schedule.
   */
  catchup?: 'latest' | 'skip' | undefined;
  /** Create paused (never due until `resume`). On `upsert`, omit to keep the current paused state. */
  paused?: boolean | undefined;
  /** Free-form note shown with the schedule (why it exists / why it's paused). */
  note?: string | undefined;
  /** Namespace of the schedule and of the runs it starts. Defaults to the engine's own namespace. */
  namespace?: string | undefined;
  /** Labels to find the schedule by — also stamped on every run it starts (plus `schedule:<id>`). */
  tags?: string[] | undefined;
  /** Search attributes stamped on every run it starts. */
  searchAttributes?: SearchAttributes | undefined;
  /** Dispatch priority for the runs it starts. */
  priority?: number | undefined;
  /**
   * A start-time concurrency quota applied to every run it starts (see `StartOptions.concurrency`):
   * a window whose start would exceed it is recorded as the schedule's `lastError` and skipped, and
   * the schedule moves on to its next window.
   */
  concurrency?: ConcurrencyQuota | undefined;
  /**
   * The customer the schedule belongs to; every run it starts inherits it. An explicit value wins
   * (`null` = none); omit it and the schedule takes the context tenant when tenancy is on. On
   * `upsert`, omit to keep the schedule's current tenant.
   */
  tenantId?: string | null | undefined;
  /** The kind of {@link tenantId}. Only read with an explicit `tenantId`. */
  tenantKind?: string | undefined;
}

/** A schedule as `engine.schedules.get/list` describe it. */
export interface ScheduleDescription {
  id: string;
  workflow: string;
  input: unknown;
  namespace: string;
  cron?: string | undefined;
  everyMs?: number | undefined;
  rrule?: string | undefined;
  timezone?: string | undefined;
  jitterMs?: number | undefined;
  overlap: 'allow' | 'skip';
  catchup: 'latest' | 'skip';
  paused: boolean;
  note?: string | undefined;
  tags?: string[] | undefined;
  searchAttributes?: SearchAttributes | undefined;
  priority?: number | undefined;
  concurrency?: ConcurrencyQuota | undefined;
  /** When it is next due (jitter included), or null if it never fires again / paused. */
  nextFireAt: Date | null;
  /** The last window it fired for, and the run that window started. */
  lastFireAt?: Date | undefined;
  lastRunId?: string | undefined;
  /** How many windows it has fired (manual triggers excluded). */
  fires: number;
  /** The last start failure (e.g. a concurrency limit), cleared by the next successful start. */
  lastError?: string | undefined;
  /** The customer the schedule and its runs belong to, when it has one. */
  tenantId?: string | undefined;
  tenantKind?: string | undefined;
  /**
   * Set on a schedule a tenant app ANNOUNCED (its `schedules` module option) and the control plane
   * adopted: the key the app declares it under. Its `namespace` is the app (partition).
   */
  announcedKey?: string | undefined;
  /** An announced schedule that no live worker of its app announces any more: since when. */
  unannouncedSince?: Date | undefined;
  /** When the control plane paused it for staying unannounced past the grace period. */
  withdrawnAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
}

/** The tag on every schedule adopted from a tenant's announcement (and on the runs it starts). */
export const ANNOUNCED_SCHEDULE_TAG = 'schedule:announced';

/** The control plane's schedule id for the schedule `key` announced by the app on `namespace`. */
export function announcedScheduleId(namespace: string, key: string): string {
  return `app:${namespace}:${key}`;
}

/** The `error.code` of a run parked until a worker is live (engine's `NO_LIVE_WORKER`). */
const PARKED_FOR_WORKER = 'no_live_worker';

/** Filter for `engine.schedules.list`. */
export type ScheduleListQuery = Omit<ScheduleQuery, 'dueBy'>;

/** Thrown by `engine.schedules.create` when the id is taken (use `upsert` to replace). */
export class ScheduleAlreadyExistsError extends Error {
  constructor(readonly scheduleId: string) {
    super(`schedule "${scheduleId}" already exists`);
    this.name = 'ScheduleAlreadyExistsError';
  }
}

/** Thrown by `engine.schedules.*` on an id that doesn't exist. */
export class ScheduleNotFoundError extends Error {
  constructor(readonly scheduleId: string) {
    super(`schedule "${scheduleId}" not found`);
    this.name = 'ScheduleNotFoundError';
  }
}

/** The persisted definition (`ScheduleRecord.spec`). Versioned so the shape can evolve. */
interface SpecDoc {
  v: 1;
  input?: unknown;
  cron?: string;
  everyMs?: number;
  rrule?: string;
  timezone?: string;
  jitterMs?: number;
  overlap: 'allow' | 'skip';
  catchup: 'latest' | 'skip';
  note?: string;
  searchAttributes?: SearchAttributes;
  priority?: number;
  concurrency?: ConcurrencyQuota;
}

/** The persisted bookkeeping (`ScheduleRecord.state`). */
interface StateDoc {
  /** The nominal window `nextFireAt` belongs to (nextFireAt = window + jitter). */
  window?: number | null | undefined;
  lastFireAt?: number | undefined;
  lastRunId?: string | undefined;
  fires?: number | undefined;
  lastError?: string | undefined;
  /** Present on a schedule adopted from a tenant's announcement — see {@link AnnounceDoc}. */
  announce?: AnnounceDoc | undefined;
}

/** The announcement bookkeeping of an adopted schedule (see {@link ScheduleClient.syncAnnounced}). */
interface AnnounceDoc {
  /** The key the app declares it under. */
  key: string;
  /** The announced definition, as stable JSON: a change re-applies it, an equal one writes nothing. */
  fingerprint: string;
  /** The app declared it `paused`. */
  declaredPaused?: boolean | undefined;
  /** First sync at which no live worker of the app announced it any more. */
  missingSince?: number | undefined;
  /** When it was paused for staying unannounced past the grace period. */
  withdrawnAt?: number | undefined;
  /** It was already paused (by an operator) when it was withdrawn: a re-announce keeps it paused. */
  pausedBeforeWithdrawal?: boolean | undefined;
  /** The schedule's note when it was withdrawn (an operator's pause reason), put back on restore. */
  noteBeforeWithdrawal?: string | undefined;
}

/** What {@link ScheduleClient.syncAnnounced} did to a namespace's adopted schedules. */
export interface AnnouncedScheduleSync {
  /** Created, or re-applied because the announced definition changed. */
  adopted: string[];
  /** Announced again after missing (and resumed, when it had been withdrawn). */
  restored: string[];
  /** Missing from the announcement for the first time: the grace period starts. */
  missing: string[];
  /** Paused because it stayed unannounced past the grace period. */
  withdrawn: string[];
  /** Announced, but the definition does not evaluate (bad cron, both or neither cadence). */
  invalid: { key: string; error: string }[];
}

/** The engine surface the schedule client drives. */
export interface ScheduleHost {
  start(workflow: string, input: unknown, runId: string, opts?: StartOptions): Promise<RunResult>;
  /**
   * The tenant start path, used to fire an announced schedule: a workflow no live worker serves yet
   * is parked `blocked` (`no_live_worker`) until one is, instead of throwing. Absent = `start`.
   */
  startParked?(
    workflow: string,
    input: unknown,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  getRun(runId: string): Promise<WorkflowRun | null>;
  /** True once the engine has begun shutting down; `tick` fires nothing more after that. */
  isDraining?(): boolean;
  /** The context tenant to stamp on a schedule created now (tenancy on), else undefined. */
  tenant?(): RunTenant | undefined;
  /** The tenancy matching filter for an app-facing call made now. Absent = sees everything. */
  tenantFilter?(): TenantFilter;
}

/** Engine-level knobs for the client. */
export interface ScheduleClientOptions {
  /** The engine's namespace: the default for new schedules, and which ones `tick` fires. */
  namespace?: string | undefined;
  clock?: (() => number) | undefined;
}

const DEFAULT_NAMESPACE = 'default';
/** How late a window may fire under `catchup: 'skip'` and still count as on time (plus jitter). */
const ON_TIME_GRACE_MS = 60_000;
const TICK_BATCH = 100;

/**
 * Persisted, runtime-managed schedules — `engine.schedules`. Unlike the code-registered
 * `schedules` module option, these live in the store: create/update/pause/delete them at runtime
 * (one per user, per tenant, per automation…), and every driving engine's timer poll fires the due
 * ones via {@link tick}.
 *
 * Multi-worker safety comes from two properties, not from a lock: a window's run id is deterministic
 * (`sched:<id>:<windowMs>`), so racing starts of the same window collapse into one run; and a
 * schedule is advanced with a compare-and-set on its `nextFireAt`, so exactly one poller moves it on.
 * A crash between starting the run and advancing the schedule just re-fires the (idempotent) start.
 */
export class ScheduleClient {
  constructor(
    private readonly store: StateStore,
    private readonly host: ScheduleHost,
    private readonly options: ScheduleClientOptions = {},
  ) {}

  private now(): number {
    return (this.options.clock ?? Date.now)();
  }

  /** Whether the store persists schedules (implements the schedule methods). */
  get supported(): boolean {
    const s = this.store;
    return !!(
      s.saveSchedule &&
      s.getSchedule &&
      s.updateSchedule &&
      s.deleteSchedule &&
      s.listSchedules
    );
  }

  private requireStore(): Required<
    Pick<
      StateStore,
      'saveSchedule' | 'getSchedule' | 'updateSchedule' | 'deleteSchedule' | 'listSchedules'
    >
  > {
    if (!this.supported) {
      throw new Error(
        'persisted schedules need a store that implements saveSchedule/getSchedule/updateSchedule/deleteSchedule/listSchedules — every bundled store adapter does; this one does not',
      );
    }
    const s = this.store;
    return {
      saveSchedule: (r) => (s.saveSchedule as NonNullable<StateStore['saveSchedule']>).call(s, r),
      getSchedule: (id) => (s.getSchedule as NonNullable<StateStore['getSchedule']>).call(s, id),
      updateSchedule: (id, patch, expected) =>
        (s.updateSchedule as NonNullable<StateStore['updateSchedule']>).call(
          s,
          id,
          patch,
          expected,
        ),
      deleteSchedule: (id) =>
        (s.deleteSchedule as NonNullable<StateStore['deleteSchedule']>).call(s, id),
      listSchedules: (q) =>
        (s.listSchedules as NonNullable<StateStore['listSchedules']>).call(s, q),
    };
  }

  private filter(): TenantFilter {
    return this.host.tenantFilter?.() ?? { mode: 'system' };
  }

  /** The schedule `id` if it exists and the caller may see it (tenancy), else null. */
  private async visible(id: string): Promise<ScheduleRecord | null> {
    const record = await this.requireStore().getSchedule(id);
    return record && tenantVisible(record, this.filter()) ? record : null;
  }

  /** Create a schedule. Throws {@link ScheduleAlreadyExistsError} if the id is taken. */
  async create(opts: ScheduleOptions): Promise<ScheduleDescription> {
    const store = this.requireStore();
    if (await store.getSchedule(opts.id)) throw new ScheduleAlreadyExistsError(opts.id);
    return this.write(opts, null);
  }

  /**
   * Create the schedule, or replace the definition of an existing one (its history — last fire, last
   * run, fire count — is kept). The next fire is recomputed from now under the new definition, so a
   * window that already fired is never fired again by an upsert.
   */
  async upsert(opts: ScheduleOptions): Promise<ScheduleDescription> {
    const store = this.requireStore();
    const existing = await store.getSchedule(opts.id);
    // Another tenant's schedule is never replaced: its id is taken, and the caller can't see it.
    if (existing && !tenantVisible(existing, this.filter())) {
      throw new ScheduleAlreadyExistsError(opts.id);
    }
    return this.write(opts, existing);
  }

  /** The schedule `id`, or null (also null for another tenant's schedule). */
  async get(id: string): Promise<ScheduleDescription | null> {
    const record = await this.visible(id);
    return record ? describe(record) : null;
  }

  /** Schedules matching `query` (and visible to the caller's tenant), soonest-due first. */
  async list(query: ScheduleListQuery = {}): Promise<ScheduleDescription[]> {
    return (await this.requireStore().listSchedules(scopeTenantQuery(query, this.filter()))).map(
      describe,
    );
  }

  /** Delete the schedule. Runs it already started are left alone. Returns whether it existed. */
  async delete(id: string): Promise<boolean> {
    if (!(await this.visible(id))) return false;
    return this.requireStore().deleteSchedule(id);
  }

  /** Stop firing until {@link resume}. `note` records why (shown by `get`/`list`). */
  async pause(id: string, note?: string): Promise<ScheduleDescription> {
    const store = this.requireStore();
    const record = await this.mustGet(id);
    const spec = { ...(record.spec as unknown as SpecDoc) };
    if (note !== undefined) spec.note = note;
    await store.updateSchedule(id, {
      paused: true,
      spec: spec as unknown as Record<string, unknown>,
      updatedAt: new Date(this.now()),
    });
    return describe(await this.mustGet(id));
  }

  /**
   * Fire again from the next window after now — the windows skipped while paused are NOT caught up.
   */
  async resume(id: string): Promise<ScheduleDescription> {
    const store = this.requireStore();
    const record = await this.mustGet(id);
    const spec = record.spec as unknown as SpecDoc;
    const window = nextWindowAfter(spec, this.now());
    await store.updateSchedule(id, {
      paused: false,
      nextFireAt: window === null ? null : window + jitterFor(record.id, window, spec),
      state: { ...record.state, window } as Record<string, unknown>,
      updatedAt: new Date(this.now()),
    });
    return describe(await this.mustGet(id));
  }

  /**
   * Start one run of the schedule right now, outside its cadence (paused or not). The run id is
   * `sched:<id>:manual:<nowMs>`; it doesn't move the schedule's next fire.
   */
  async trigger(id: string): Promise<RunResult> {
    const record = await this.mustGet(id);
    const runId = `sched:${id}:manual:${this.now()}`;
    return this.startFor(record, runId);
  }

  /**
   * Start one run of `record`: through the tenant start path for an announced schedule (its run waits
   * `blocked` for a live worker of its app instead of failing), else a plain `start`.
   */
  private startFor(record: ScheduleRecord, runId: string): Promise<RunResult> {
    const input = specOf(record).input;
    const opts = startOptions(record);
    if (isAnnounced(record) && this.host.startParked) {
      return this.host.startParked(record.workflow, input, runId, opts);
    }
    return this.host.start(record.workflow, input, runId, opts);
  }

  /**
   * Fire every due schedule (in this engine's namespace; all namespaces for an operator engine; only
   * those carrying `opts.tag` when given):
   * start its window's run and advance it to the next window. Called by the NestJS timer poller on
   * each tick when `persistedSchedules` is on; call it yourself from any other driver. Returns the
   * run ids started (or re-found, for an idempotent re-fire).
   */
  async tick(nowMs: number = this.now(), opts: { tag?: string } = {}): Promise<string[]> {
    const store = this.requireStore();
    const started: string[] = [];
    for (let round = 0; round < 50; round++) {
      if (this.host.isDraining?.()) break;
      const due = await store.listSchedules({
        dueBy: nowMs,
        namespace: this.options.namespace,
        ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
        limit: TICK_BATCH,
      });
      for (const record of due) {
        if (this.host.isDraining?.()) return started; // shutting down: start nothing new
        const runId = await this.fire(record, nowMs);
        if (runId) started.push(runId);
      }
      if (due.length < TICK_BATCH) break;
    }
    return started;
  }

  /**
   * When {@link tick} next has a schedule to fire, if one is due by `byMs`: the earliest `nextFireAt`
   * of the unpaused schedules (of this engine's namespace, carrying `opts.tag` when given) due by
   * then, else `undefined`. One indexed
   * read (the due-schedule scan `tick` makes, with a later bound and a limit of one). A store that
   * does not persist schedules has none.
   */
  async nextFireAt(byMs: number, opts: { tag?: string } = {}): Promise<number | undefined> {
    if (!this.supported) return undefined;
    const [next] = await this.requireStore().listSchedules({
      dueBy: byMs,
      namespace: this.options.namespace,
      ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
      limit: 1,
    });
    return next?.nextFireAt ?? undefined;
  }

  /** Fire one due schedule and advance it. Returns the run id started, if any. */
  private async fire(record: ScheduleRecord, nowMs: number): Promise<string | undefined> {
    const store = this.requireStore();
    const spec = specOf(record);
    const state = record.state as StateDoc;
    let latest: number;
    let next: number | null;
    try {
      // The most recent window at or before now — the one (and only one) a late poll fires.
      latest = latestWindowAtOrBefore(spec, nowMs);
      next = nextWindowAfter(spec, latest);
    } catch (error) {
      // A definition that no longer evaluates (bad cron/timezone): stop it, loudly, instead of
      // failing on every tick forever.
      await store.updateSchedule(
        record.id,
        {
          paused: true,
          nextFireAt: null,
          state: { ...state, lastError: `invalid schedule: ${errorMessage(error)}` },
          updatedAt: new Date(nowMs),
        },
        record.nextFireAt,
      );
      return undefined;
    }
    const window = state.window ?? latest;
    const jitter = spec.jitterMs ?? 0;
    const onTime = nowMs - latest <= ON_TIME_GRACE_MS + jitter;
    let runId: string | undefined;
    let lastError: string | undefined;
    let fired = false;
    const skipMissed = spec.catchup === 'skip' && !onTime;
    const beforeWindow = latest < window; // clock skew: not actually due yet
    if (
      !skipMissed &&
      !beforeWindow &&
      !(await this.overlapping(spec, state)) &&
      !(await this.waitingForWorker(record, state))
    ) {
      runId = `sched:${record.id}:${latest}`;
      try {
        await this.startFor(record, runId);
        fired = true;
      } catch (error) {
        // A racing poller may have created the same (deterministic) run first: that's a success.
        if (await this.host.getRun(runId)) fired = true;
        else lastError = errorMessage(error);
      }
    }
    const nextState: StateDoc = {
      ...state,
      window: next,
      ...(fired ? { lastFireAt: latest, lastRunId: runId, fires: (state.fires ?? 0) + 1 } : {}),
      lastError: fired ? undefined : (lastError ?? state.lastError),
    };
    await store.updateSchedule(
      record.id,
      {
        nextFireAt: next === null ? null : next + jitterFor(record.id, next, spec),
        state: stripUndefined(nextState) as Record<string, unknown>,
        updatedAt: new Date(nowMs),
      },
      record.nextFireAt,
    );
    return fired ? runId : undefined;
  }

  /**
   * An announced schedule whose previous run is still parked waiting for a live worker of its app
   * (the app is down): this window is folded into that run instead of parking one more. However long
   * the app is down, it finds at most one run per schedule waiting when it comes back, the same
   * bound `catchup: 'latest'` puts on windows missed while no scheduler polled.
   */
  private async waitingForWorker(record: ScheduleRecord, state: StateDoc): Promise<boolean> {
    if (!isAnnounced(record) || !state.lastRunId) return false;
    const prev = await this.host.getRun(state.lastRunId);
    return prev?.status === 'blocked' && prev.error?.code === PARKED_FOR_WORKER;
  }

  /**
   * Reconcile the schedules adopted from one app (`namespace`) with what its LIVE workers announce
   * now (`items`, one per key; the caller resolved disagreeing workers). The rule:
   *  - an announced key with no schedule yet is created (id {@link announcedScheduleId}, tagged
   *    {@link ANNOUNCED_SCHEDULE_TAG}, `catchup: 'latest'`); one whose definition changed is
   *    re-applied like `upsert` (its history kept, its next fire recomputed from now). An equal
   *    definition writes nothing, so any number of replicas announcing the same set is a no-op;
   *  - a pause or resume made from the console survives: a re-applied definition keeps the current
   *    paused state, unless the app's own declared `paused` changed;
   *  - an adopted schedule the app no longer announces is marked missing, and paused ("withdrawn")
   *    once it has stayed missing for `graceMs`. It is never deleted: its history stays, and an app
   *    that announces it again (a rollback) gets it back, resumed unless an operator had paused it.
   *
   * Call it only for an app that has at least one live worker stating its schedules: with none (the
   * app is down, or runs an SDK that does not announce schedules), nothing is withdrawn, and its
   * schedules keep firing into runs that wait for a worker.
   */
  async syncAnnounced(
    namespace: string,
    items: readonly AnnouncedSchedule[],
    opts: { nowMs?: number; graceMs: number },
  ): Promise<AnnouncedScheduleSync> {
    const store = this.requireStore();
    const now = opts.nowMs ?? this.now();
    const out: AnnouncedScheduleSync = {
      adopted: [],
      restored: [],
      missing: [],
      withdrawn: [],
      invalid: [],
    };
    const adopted = new Map<string, ScheduleRecord>();
    for (let offset = 0; ; offset += TICK_BATCH) {
      const page = await store.listSchedules({
        namespace,
        tag: ANNOUNCED_SCHEDULE_TAG,
        limit: TICK_BATCH,
        offset,
      });
      for (const record of page) if (isAnnounced(record)) adopted.set(record.id, record);
      if (page.length < TICK_BATCH) break;
    }
    for (const item of items) {
      const id = announcedScheduleId(namespace, item.key);
      const existing = adopted.get(id) ?? (await store.getSchedule(id));
      adopted.delete(id);
      const doc = existing ? (existing.state as StateDoc).announce : undefined;
      if (existing && !doc) {
        // A schedule someone created by hand under this id: never taken over.
        out.invalid.push({ key: item.key, error: `schedule id "${id}" is taken` });
        continue;
      }
      const fingerprint = stableJson(item);
      if (existing && doc && doc.fingerprint === fingerprint) {
        if (doc.missingSince === undefined && doc.withdrawnAt === undefined) continue;
        // Announced again after missing: the grace period ends, and a withdrawal is undone.
        const resume =
          doc.withdrawnAt !== undefined && !doc.pausedBeforeWithdrawal && existing.paused;
        const spec = specOf(existing);
        const window = resume ? nextWindowAfter(spec, now) : undefined;
        await store.updateSchedule(id, {
          // The withdrawal note goes; the note it replaced comes back.
          ...(doc.withdrawnAt !== undefined
            ? {
                spec: stripUndefined({
                  ...spec,
                  note: doc.noteBeforeWithdrawal,
                }) as unknown as Record<string, unknown>,
              }
            : {}),
          ...(resume
            ? {
                paused: false,
                nextFireAt: window == null ? null : window + jitterFor(id, window, spec),
              }
            : {}),
          state: stripUndefined({
            ...(existing.state as StateDoc),
            ...(resume ? { window } : {}),
            announce: { key: doc.key, fingerprint, declaredPaused: doc.declaredPaused },
          }) as Record<string, unknown>,
          updatedAt: new Date(now),
        });
        out.restored.push(id);
        continue;
      }
      // New, or the definition changed. The paused state the console set is kept, unless the app's
      // declared `paused` changed or the schedule was only paused because it had been withdrawn.
      const declaredPaused = item.paused === true;
      const paused =
        existing === null || existing === undefined
          ? declaredPaused
          : declaredPaused !== (doc?.declaredPaused === true)
            ? declaredPaused
            : doc?.withdrawnAt !== undefined && !doc.pausedBeforeWithdrawal
              ? declaredPaused
              : undefined;
      try {
        await this.write(
          {
            id,
            workflow: item.workflow,
            input: item.input,
            cron: item.cron,
            every: item.everyMs,
            timezone: item.timezone,
            jitter: item.jitterMs,
            overlap: item.overlap,
            catchup: 'latest',
            namespace,
            tags: [ANNOUNCED_SCHEDULE_TAG],
            paused,
            // A note (an operator's pause reason) is kept; a withdrawal note is replaced by the one
            // it had replaced.
            note:
              doc?.withdrawnAt !== undefined
                ? doc.noteBeforeWithdrawal
                : existing
                  ? specOf(existing).note
                  : undefined,
            // Fires belong to the app, never to whichever request context reached the sync.
            ...(existing ? {} : { tenantId: null }),
          },
          existing ?? null,
          { announce: { key: item.key, fingerprint, declaredPaused } },
        );
        out.adopted.push(id);
      } catch (error) {
        out.invalid.push({ key: item.key, error: errorMessage(error) });
      }
    }
    // Adopted, but announced by no live worker of the app any more.
    for (const record of adopted.values()) {
      const state = record.state as StateDoc;
      const doc = state.announce as AnnounceDoc;
      if (doc.withdrawnAt !== undefined) continue;
      if (doc.missingSince === undefined) {
        await store.updateSchedule(record.id, {
          state: { ...state, announce: { ...doc, missingSince: now } } as Record<string, unknown>,
          updatedAt: new Date(now),
        });
        out.missing.push(record.id);
        continue;
      }
      if (now - doc.missingSince < opts.graceMs) continue;
      const spec = { ...specOf(record) };
      spec.note = `withdrawn: app "${namespace}" no longer announces schedule "${doc.key}"`;
      await store.updateSchedule(record.id, {
        paused: true,
        spec: spec as unknown as Record<string, unknown>,
        state: {
          ...state,
          announce: stripUndefined({
            ...doc,
            withdrawnAt: now,
            pausedBeforeWithdrawal: record.paused,
            noteBeforeWithdrawal: specOf(record).note,
          }),
        } as Record<string, unknown>,
        updatedAt: new Date(now),
      });
      out.withdrawn.push(record.id);
    }
    return out;
  }

  /** `overlap: 'skip'` and the previous run of this schedule is still in flight. */
  private async overlapping(spec: SpecDoc, state: StateDoc): Promise<boolean> {
    if (spec.overlap !== 'skip' || !state.lastRunId) return false;
    const prev = await this.host.getRun(state.lastRunId);
    return !!prev && !TERMINAL_RUN_STATUSES.includes(prev.status as RunStatus);
  }

  private async mustGet(id: string): Promise<ScheduleRecord> {
    const record = await this.visible(id);
    if (!record) throw new ScheduleNotFoundError(id);
    return record;
  }

  /** Explicit `opts.tenantId` → the existing schedule's tenant (upsert) → the context tenant → none. */
  private scheduleTenant(
    opts: ScheduleOptions,
    existing: ScheduleRecord | null,
  ): Pick<ScheduleRecord, 'tenantId' | 'tenantKind'> {
    let tenant: RunTenant | undefined;
    if (opts.tenantId !== undefined) {
      tenant = opts.tenantId === null ? undefined : { id: opts.tenantId, kind: opts.tenantKind };
    } else if (existing) {
      tenant =
        existing.tenantId == null
          ? undefined
          : { id: existing.tenantId, kind: existing.tenantKind ?? undefined };
    } else {
      tenant = this.host.tenant?.();
    }
    if (!tenant) return {};
    return tenant.kind !== undefined
      ? { tenantId: tenant.id, tenantKind: tenant.kind }
      : { tenantId: tenant.id };
  }

  private async write(
    opts: ScheduleOptions,
    existing: ScheduleRecord | null,
    extraState: Partial<StateDoc> = {},
  ): Promise<ScheduleDescription> {
    const store = this.requireStore();
    const spec = toSpec(opts);
    const now = this.now();
    // An upsert that doesn't say otherwise keeps a paused schedule paused.
    const paused = opts.paused ?? existing?.paused ?? false;
    const window = nextWindowAfter(spec, now); // also validates the cron/timezone up front
    const record: ScheduleRecord = {
      id: opts.id,
      namespace: opts.namespace ?? this.options.namespace ?? DEFAULT_NAMESPACE,
      workflow: workflowName(opts.workflow),
      paused,
      nextFireAt: window === null ? null : window + jitterFor(opts.id, window, spec),
      tags: opts.tags,
      spec: spec as unknown as Record<string, unknown>,
      state: stripUndefined({
        ...((existing?.state as StateDoc | undefined) ?? {}),
        window,
        ...extraState,
      }) as Record<string, unknown>,
      ...this.scheduleTenant(opts, existing),
      createdAt: existing?.createdAt ?? new Date(now),
      updatedAt: new Date(now),
    };
    await store.saveSchedule(record);
    return describe(record);
  }
}

function toSpec(opts: ScheduleOptions): SpecDoc {
  const kinds = [opts.cron, opts.every, opts.rrule].filter((k) => k != null).length;
  if (kinds !== 1) {
    throw new Error(`schedule "${opts.id}" needs exactly one of "cron", "every" or "rrule"`);
  }
  if (opts.rrule != null) parseRRule(opts.rrule, opts.timezone); // refuse a bad rule at create
  const everyMs = opts.every != null ? parseDuration(opts.every) : undefined;
  if (everyMs !== undefined && !(everyMs > 0)) {
    throw new Error(`schedule "${opts.id}": "every" must be a positive duration`);
  }
  const jitterMs = opts.jitter != null ? parseDuration(opts.jitter) : undefined;
  return stripUndefined({
    v: 1 as const,
    input: opts.input,
    cron: opts.cron,
    everyMs,
    rrule: opts.rrule,
    timezone: opts.timezone,
    jitterMs: jitterMs && jitterMs > 0 ? jitterMs : undefined,
    overlap: opts.overlap ?? 'allow',
    catchup: opts.catchup ?? 'latest',
    note: opts.note,
    searchAttributes: opts.searchAttributes,
    priority: opts.priority,
    concurrency: opts.concurrency,
  }) as SpecDoc;
}

function specOf(record: ScheduleRecord): SpecDoc {
  return record.spec as unknown as SpecDoc;
}

/** Adopted from a tenant's announcement (see {@link ScheduleClient.syncAnnounced}). */
function isAnnounced(record: ScheduleRecord): boolean {
  return (record.state as StateDoc | undefined)?.announce !== undefined;
}

/** The latest window at or before `atMs`. */
function latestWindowAtOrBefore(spec: SpecDoc, atMs: number): number {
  if (spec.cron != null) return prevCronFireMs(spec.cron, atMs, spec.timezone);
  if (spec.rrule != null) {
    const prev = prevRRuleFireMs(parseRRule(spec.rrule, spec.timezone), atMs);
    if (prev === null)
      throw new Error(
        `rrule "${spec.rrule}" has no occurrence at or before ${new Date(atMs).toISOString()}`,
      );
    return prev;
  }
  const every = spec.everyMs as number;
  return Math.floor(atMs / every) * every;
}

/** The first window strictly after `afterMs`. */
function nextWindowAfter(spec: SpecDoc, afterMs: number): number | null {
  if (spec.cron != null) return nextCronFireMs(spec.cron, afterMs, spec.timezone);
  if (spec.rrule != null) return nextRRuleFireMs(parseRRule(spec.rrule, spec.timezone), afterMs);
  const every = spec.everyMs as number;
  return (Math.floor(afterMs / every) + 1) * every;
}

/** A stable offset in `[0, jitterMs)` per (schedule, window): FNV-1a over the pair. */
function jitterFor(id: string, window: number, spec: SpecDoc): number {
  const max = spec.jitterMs ?? 0;
  if (max <= 0) return 0;
  let h = 0x811c9dc5;
  for (const ch of `${id}@${window}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % max;
}

function startOptions(record: ScheduleRecord): StartOptions {
  const spec = specOf(record);
  return stripUndefined({
    tags: [...(record.tags ?? []), `schedule:${record.id}`],
    namespace: record.namespace,
    searchAttributes: spec.searchAttributes,
    priority: spec.priority,
    concurrency: spec.concurrency,
    // Every fire belongs to the schedule's customer (or explicitly to none), never to whichever
    // poller or request happened to fire it.
    ...inheritTenant(record),
  }) as StartOptions;
}

function describe(record: ScheduleRecord): ScheduleDescription {
  const spec = specOf(record);
  const state = record.state as StateDoc;
  return stripUndefined({
    id: record.id,
    workflow: record.workflow,
    input: spec.input,
    namespace: record.namespace,
    cron: spec.cron,
    everyMs: spec.everyMs,
    rrule: spec.rrule,
    timezone: spec.timezone,
    jitterMs: spec.jitterMs,
    overlap: spec.overlap ?? 'allow',
    catchup: spec.catchup ?? 'latest',
    paused: record.paused,
    note: spec.note,
    tags: record.tags,
    searchAttributes: spec.searchAttributes,
    priority: spec.priority,
    concurrency: spec.concurrency,
    nextFireAt: record.paused || record.nextFireAt == null ? null : new Date(record.nextFireAt),
    lastFireAt: state.lastFireAt != null ? new Date(state.lastFireAt) : undefined,
    lastRunId: state.lastRunId,
    fires: state.fires ?? 0,
    lastError: state.lastError,
    tenantId: record.tenantId ?? undefined,
    tenantKind: record.tenantKind ?? undefined,
    announcedKey: state.announce?.key,
    unannouncedSince:
      state.announce?.missingSince != null ? new Date(state.announce.missingSince) : undefined,
    withdrawnAt:
      state.announce?.withdrawnAt != null ? new Date(state.announce.withdrawnAt) : undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }) as ScheduleDescription;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
