import type { z } from 'zod';
import type { WorkerDescriptor } from './handshake/descriptor';
import type { DispatchDiagnostics } from './handshake/dispatch-routing';
import type { StandardSchemaV1 } from './standard-schema';
import type { StepRef } from './step-name-symbol';
import type { WorkflowClass, WorkflowInputOf, WorkflowOutputOf } from './workflow-ref';

/**
 * Core type contracts for nestjs-durable.
 *
 * These are intentionally framework-agnostic: `@dudousxd/nestjs-durable-core` knows only
 * these interfaces, never a concrete transport, store or ORM. Adapters implement them.
 */

// ---------------------------------------------------------------------------
// Runs & checkpoints — the durable state owned by the orchestrator
// ---------------------------------------------------------------------------

export type RunStatus =
  /** Created + enqueued by `start`, not yet picked up — a worker will lease and execute it. */
  | 'pending'
  | 'running'
  | 'suspended'
  /**
   * Compensating cancel in progress: `cancel(runId, { compensate: true })` has been requested and the
   * saga undo is running in the background. NON-TERMINAL — the run is still in-flight (counted by the
   * admission gate, re-driven by recovery if the engine crashes mid-compensation), and flips to
   * `cancelled` once compensation completes. A non-compensating cancel skips this and goes straight to
   * `cancelled`.
   */
  | 'cancelling'
  /**
   * No live worker on the run's next-dispatch group is BOTH capability-capable and protocol-compatible
   * (handshake design §7.5). NON-TERMINAL — the run wrote no `pending` checkpoint and dispatched
   * nothing; it carries a `wakeAt` so the blocked-recovery poll re-drives it to re-check the live
   * fleet, and proceeds the moment a capable+compatible worker appears. Only engaged when descriptors
   * are actually published (a legacy/pre-handshake fleet skips the guard, design §7.7).
   */
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** Dead-letter: recovery gave up after `maxRecoveryAttempts` (a poison pill). Terminal; inspect it. */
  | 'dead';

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
  error?: StepError | undefined;
  /** When `suspended` on a durable sleep: epoch ms at which the run becomes due to resume. */
  wakeAt?: number | undefined;
  /** Recovery lease owner (engine instance id) while a run is being resumed. */
  lockedBy?: string | undefined;
  /** Recovery lease expiry (epoch ms); another instance may take over once it passes. */
  lockedUntil?: number | undefined;
  /** How many times crash-recovery has picked this run up — caps poison pills (see maxRecoveryAttempts). */
  recoveryAttempts?: number | undefined;
  /** Searchable labels: the workflow's static `@Workflow({ tags })` merged with the run's start-time tags. */
  tags?: string[] | undefined;
  /** Typed, queryable run data (e.g. `{ amount: 200, tier: 'pro' }`) — see {@link RunQuery.attributes}. */
  searchAttributes?: SearchAttributes | undefined;
  /**
   * The worker-pool partition this run belongs to. Stamped at creation from the creating engine's
   * `namespace` (default `'default'`). A worker only picks up / recovers / resumes-timers-for /
   * times-out runs in its own namespace. `undefined` on a run created before this field existed; the
   * store persists it as `'default'`. Read paths (dashboard, `getRun`) are NOT namespace-scoped.
   */
  namespace?: string | undefined;
  /**
   * The npm package that DECLARED this run's workflow — e.g. `@dudousxd/nestjs-catalog-pipeline` for
   * a workflow shipped by a library, or the host app's own `package.json` `name` for one written in
   * the app. This is a CODE-PROVENANCE axis ("which lib owns this body"), NOT a tenancy axis — for
   * that, see {@link namespace}.
   *
   * Stamped at creation from the workflow's registration, exactly as {@link namespace} is stamped
   * from the creating engine. It is DERIVED, never caller input: `StartOptions` has no `origin`, so
   * nothing a caller passes to `start` can make a run claim another lib's name.
   *
   * `undefined` means UNKNOWN — never "the app". It is what you get for a run created before this
   * field existed, for a registration path that carries no origin (`registerRemote`, convention
   * routing, a synthesized remote child, or a bare `engine.register` with no `origin` option), and
   * for a workflow whose declaring package could not be resolved with confidence. A wrong origin is
   * worse than an absent one: a filter that silently drops runs looks exactly like runs that never
   * existed, so callers must render unknown as unknown and never fold it into a real package.
   */
  origin?: string | undefined;
  /**
   * Dispatch priority for a REMOTE run (one advanced by a {@link WorkflowExecutor} over a broker):
   * carried onto each {@link WorkflowTask} so an urgent child workflow can jump ahead of enqueued
   * lower-priority ones at the worker. Higher wins; absent = unprioritised. Best-effort ordering, not
   * durable state required for correctness — a transport without priority support ignores it.
   */
  priority?: number | undefined;
  /**
   * REMOTE workflow turn awaiting a decision: the `taskId` of the turn the engine dispatched to a
   * workflow worker and then SUSPENDED on. Set by the dispatch-and-suspend path; matched by
   * {@link WorkflowEngine.completeRemoteDecision} so ONLY the decision for the currently-awaited turn
   * is applied (a stale/duplicate/foreign decision is dropped), then cleared the moment it is applied.
   * This is what makes a workflow-turn decision multi-instance safe: any engine instance that receives
   * the decision looks the run up by `decision.runId` and applies it durably, instead of resolving an
   * in-memory promise that only the dispatching instance held. Absent on non-remote / not-awaiting runs.
   */
  awaitingDecisionTaskId?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * WHAT an event-parked suspended run is waiting on, resolved for display — the engine keeps one
 * generic `suspended` status (it's what drives recovery/timers/queries), but to a human "waiting on
 * signal `approve`" reads very differently from "waiting on webhook `stripe-cb`". Computed by the
 * store-backed gateway from the run's signal waiters (`listSignalWaiters`, ONE bulk scan), so the
 * dashboard can NAME the wait in a list row without fetching each run's timeline. `on` is derived from
 * the waiter token's prefix (see `classifyWaiterToken`): `wh:<runId>:<seq>` ⇒ `webhook`, `child:<id>`
 * ⇒ `child`, `bp:<runId>:<seq>` ⇒ `breakpoint` (a `ctx.breakpoint` DOES register a signal waiter —
 * same machinery, `engine.continue` resumes it — so it's classified here, not left to fall through to
 * the generic `signal` case with the raw token as its ugly display name), `event:<name>:…` ⇒ `signal`
 * (name decoded), anything else ⇒ `signal` (the token IS the signal name).
 *
 * Deliberately EVENT-only (no timer/step): `wakeAt` alone can't tell a real `ctx.sleep` from the
 * reconcile-fallback `wakeAt` an event/step suspend now carries, and the store exposes no cheap bulk
 * checkpoint scan to disambiguate — so the client shows a non-event suspend with a live worker as
 * `running` (it flips off "no worker" the moment a worker returns) rather than guessing "sleeping".
 * The detail view (which has the timeline) still distinguishes sleep vs in-flight step precisely.
 */
export interface RunWaiting {
  on: 'signal' | 'webhook' | 'child' | 'breakpoint';
  /**
   * The token/name the run is parked on — the signal name, webhook token, or awaited child id. For a
   * breakpoint this is always the literal `'breakpoint'`: the real label (if any) lives on the pending
   * `breakpoint`/`breakpoint:<label>` checkpoint, which the detail view's timeline already shows —
   * naming it here would need an extra per-run checkpoint read, defeating the bulk waiter scan.
   */
  name: string;
}

export type StepKind = 'local' | 'remote' | 'sleep' | 'signal';

/**
 * The recorded result of a single step at a deterministic logical position (`seq`).
 * On replay, a `completed` checkpoint means the step is NOT re-executed — its `output` is
 * returned. A non-terminal checkpoint (`pending`/`running`) does not short-circuit: the step is
 * re-awaited (remote) or re-run (local).
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
   * `running` = a local step whose body is executing in-process right now (see `trackStepStart`);
   * it's overwritten by `completed`/`failed` when the body settles, and on a crash mid-body it
   * simply re-runs on replay (only `completed` short-circuits).
   */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** What the step was called with — the `ctx.step` (dispatched) args for a remote step (a local step has none). */
  input?: unknown;
  output?: unknown;
  error?: StepError | undefined;
  attempts: number;
  /** For remote steps: which worker group ran it. */
  workerGroup?: string | undefined;
  /** Structured events/logs the step emitted (sub-step outcomes, debug/error lines). */
  events?: StepEvent[] | undefined;
  /** For sleep steps: epoch ms the sleep elapses at. */
  wakeAt?: number | undefined;
  /**
   * Set on the running placeholder checkpoints of the children dispatched by one `ctx.all` call —
   * a shared tag (`all:<firstSeq>`) grouping the N siblings so the dashboard can render them as one
   * parallel fan-out. Optional and additive: absent on every non-`all` checkpoint. Mirrors the
   * Python SDK's `parallelGroup`.
   */
  parallelGroup?: string | undefined;
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
  /** Stable run identity for a sub-process. Distinct invocations of the same `name` carry distinct
   *  ids, so their phases and log trails never collapse into one. Absent on events emitted by the
   *  legacy `sub()` path, which keys by `name` instead. */
  subId?: string;
  /** For a sub-step/sub-process within the step: its name. */
  name?: string;
  /** Open, consumer-defined grouping label for a sub-process (e.g. a handler/lane). The dashboard
   *  groups rows by it. The library never interprets it. */
  group?: string;
  /** For a sub-step: its terminal outcome (closed enum — drives colour + aggregation). */
  status?: 'ok' | 'failed' | 'skipped';
  /** Open, consumer-defined intermediate phase label for a sub-process transition. Carries no
   *  terminal `status`; the library timestamps and orders it but never interprets it. */
  phase?: string;
  /** For a log line emitted *inside* a sub-process: that owning sub-process's name, so the dashboard
   *  can group a step's log trail under each sub-process instead of one flat list. Set on logs (no
   *  `status`); a worker stamps it from the sub-process it's running.
   *  @deprecated Superseded by `subId` for run-distinct grouping; kept so existing workers/runs render. */
  process?: string;
  /** Optional structured payload. `data.durationMs` (number) overrides the derived duration. */
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
  /** Record a sub-process event. Typically pass `phase` for an intermediate transition (carrying no
   *  terminal status), or `status` for the terminal outcome — the type permits either; the engine
   *  interprets which is set. `id` is the run identity (distinct per invocation); `group` is an
   *  open grouping label. */
  subEvent(e: {
    id: string;
    name: string;
    group?: string | undefined;
    phase?: string | undefined;
    status?: 'ok' | 'failed' | 'skipped' | undefined;
    message?: string | undefined;
    data?: unknown;
  }): void;
  /**
   * Ergonomic sub-process lifecycle: run `body`, timing it, and record a terminal `ok` with the
   * measured `durationMs` on success — or `failed` (with the error message) if it throws, then
   * re-throw. `sp.phase(label)` records an intermediate transition; `sp.skip(reason)` a terminal
   * `skipped`. Logs emitted inside `body` are tagged to this sub-process so the dashboard groups
   * them under it. Returns whatever `body` returns. The TS twin of the Python SDK's `sub_process`.
   *
   * ```ts
   * const rows = await log.subProcess('fetch-data', async () => readEverything());
   * await log.subProcess('export-file', () => upload(rows));
   * ```
   */
  subProcess<T>(
    name: string,
    body: (sp: SubProcessHandle) => Promise<T> | T,
    opts?: { group?: string; id?: string },
  ): Promise<T>;
}

/** The handle a {@link StepLogger.subProcess} body receives to mark phases / a non-`ok` outcome. */
export interface SubProcessHandle {
  /** Record an intermediate phase transition (a consumer-defined label, no terminal status). */
  phase(phase: string, data?: unknown): SubProcessHandle;
  /** Record a terminal `skipped` outcome (e.g. nothing to do / validation failed). */
  skip(reason?: string, data?: unknown): void;
  /** Record a terminal `failed` outcome explicitly (the wrapper also does this if the body throws). */
  fail(reason?: string, data?: unknown): void;
}

export interface StepError {
  message: string;
  /** Optional machine-readable code, e.g. `declined`, `timeout`. */
  code?: string | undefined;
  /** Whether the engine should treat this as retryable. */
  retryable?: boolean | undefined;
  stack?: string | undefined;
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

  /**
   * Hard-delete a run and all of its rows — the run plus its checkpoints, signal waiters, and
   * normalized search-attribute rows. Unlike a cancelled run (which stays as terminal history), a
   * deleted run is GONE: it no longer appears in {@link getRun} or {@link listRuns}. This removes
   * exactly the one run — the engine's {@link WorkflowEngine.deleteRun} handles the child cascade.
   * No-op if the run doesn't exist. (Token-keyed buffered signals are transient and left alone.)
   */
  deleteRun(runId: string): Promise<void>;

  /**
   * Hard-delete up to `limit` terminal runs that fall OUTSIDE `policy` (oldest / over the count cap
   * first), cascading to their child rows exactly like {@link deleteRun}. Returns how many runs were
   * deleted — call again while it returns `limit` to drain a large backlog in bounded batches.
   *
   * Optional: only adapters that implement a bulk prune provide it; the retention poller no-ops with a
   * warning when the configured store omits it. See {@link RetentionPolicy} for the keep/prune rule.
   */
  pruneTerminalRuns?(policy: RetentionPolicy, nowMs: number, limit: number): Promise<number>;

  getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null>;
  /**
   * Persist a checkpoint and advance the run atomically. Durable semantics depend on this
   * being a single transaction; stores without transactions cannot give the strong guarantee.
   */
  saveCheckpoint(checkpoint: StepCheckpoint): Promise<void>;

  /** Used by recovery on boot to find runs to resume (crashed, left `running`). */
  listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]>;

  /** The oldest `pending` runs awaiting dispatch (FIFO, by `createdAt`), capped at `limit`. */
  listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]>;

  /** Suspended runs whose durable timer is due (`wakeAt <= nowMs`), ready to resume. */
  listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]>;

  /**
   * Atomically acquire the recovery lease on a run for `owner` until `leaseUntilMs`, but only if
   * it is currently unlocked or its lease has expired (`<= nowMs`). Returns whether it was
   * acquired — so concurrent engine instances never recover the same run twice.
   */
  tryLockRun(runId: string, owner: string, leaseUntilMs: number, nowMs: number): Promise<boolean>;

  /** Release a run's recovery lease so another instance can pick it up (e.g. once it suspends). */
  releaseRunLock(runId: string): Promise<void>;

  /**
   * Extend a run's lease to `leaseUntilMs`, but ONLY if `owner` still holds it — so a live worker
   * heartbeating its long run keeps the lease, while a dead worker's lease still expires and gets
   * reclaimed. Returns false if the lease was lost (taken over or released).
   */
  renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean>;

  /** Record that a run is suspended waiting for an external signal `token`. */
  putSignalWaiter(waiter: SignalWaiter): Promise<void>;
  /** Atomically take (and remove) the run waiting on `token`, if any. */
  takeSignalWaiter(token: string): Promise<SignalWaiter | null>;
  /** List waiters whose `token` starts with `prefix` — used to fan out an event to its subscribers. */
  listSignalWaiters(prefix: string): Promise<SignalWaiter[]>;

  /**
   * Delete the EXACT waiter row — `token` AND `runId` AND `seq` must all match — no-op if absent.
   * Unlike {@link takeSignalWaiter}, which deletes ANY row for `token` (fine when the caller just won
   * the race to consume it), this is for a caller removing its OWN registration after resolving the
   * wait some other way (a buffered hit, a timeout): blind `takeSignalWaiter(token)` there could steal
   * a DIFFERENT run's waiter that has since claimed the same token (`token` is the store's primary key,
   * so a later `putSignalWaiter` for the same token replaces the row). The exact-match variant only
   * ever removes the row this caller itself put there.
   */
  removeSignalWaiter(waiter: SignalWaiter): Promise<void>;

  /**
   * Buffer a signal whose waiter hasn't arrived yet, so the next `waitForSignal(token)` consumes it
   * instead of it being lost (FIFO per token). Makes signals reliable regardless of timing and
   * powers `signalWithStart`.
   */
  bufferSignal(token: string, payload: unknown): Promise<void>;
  /** Take the oldest buffered signal for `token` (FIFO), or null if none is buffered. */
  takeBufferedSignal(token: string): Promise<{ payload: unknown } | null>;

  /**
   * Buffer a published event that matched NO live waiter, so a LATER `ctx.waitForEvent(name, { match })`
   * still consumes it instead of it being silently dropped — the events analog of {@link bufferSignal}'s
   * reliability contract for signals, but MATCH-based rather than token-based: an event's buffer is keyed
   * by `name` alone (many waiters can share a name with different `match` criteria), so consumption is
   * list ({@link listBufferedEvents}) + evaluate the WAITER's own match predicate + claim
   * ({@link removeBufferedEvent}) — never a blind take, because the store has no way to know which
   * candidate a given waiter wants. `input.id` is minted by the caller (engine.publishEvent) so
   * {@link removeBufferedEvent} can later target this exact row.
   */
  bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void>;
  /**
   * Buffered events for `name`, OLDEST (`publishedAt`) first, capped at `limit`. A waiter scans these,
   * evaluates its own `eventMatches(payload, match)` locally, and claims the one it wants via
   * {@link removeBufferedEvent} — the match predicate belongs to the WAITER, never the store.
   */
  listBufferedEvents(
    name: string,
    limit: number,
  ): Promise<Array<{ id: string; payload: unknown; publishedAt: number }>>;
  /**
   * Atomically delete the buffered event `id`. Returns `true` iff a row was actually deleted, `false`
   * if it was already gone (claimed by a concurrent waiter, reclaimed by `engine.publishEvent`'s own
   * late re-check, or pruned as expired) — the arbiter under concurrency: whichever caller's delete
   * returns `true` is the one that gets to deliver the payload; every other caller backs off.
   */
  removeBufferedEvent(id: string): Promise<boolean>;

  /**
   * Run `work` in a SINGLE store transaction — giving it the store-native transaction handle (`raw`)
   * for the caller's own DB writes plus a `saveCheckpoint` that commits IN THE SAME transaction, so a
   * business write and the step's "done" checkpoint are atomic (exactly-once). Optional — only the SQL
   * adapters implement it; `ctx.transaction` errors on a store without it.
   */
  transaction?<T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T>;

  // Dashboard queries
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;

  /**
   * Count the runs matching `query`, grouped by `(status, origin)` — the totals behind a console's
   * status and origin chips, in ONE aggregate instead of a full listing the caller counts in memory.
   * This is what lets a run list be paginated at all: `listRuns` can return 100 rows while the chips
   * still say how many of the 9,000 are failed.
   *
   * Cells with a zero count are simply absent. Optional: a store that omits it still works — callers
   * fall back to counting a {@link listRuns} result, which is correct but unbounded.
   */
  runFacets?(query: RunFacetQuery): Promise<RunFacetRow[]>;

  /**
   * The distinct values of ONE filter axis over the runs matching `query`, with counts — what a
   * console's tenant/tag/attribute pickers list instead of asking an operator to type a value blind.
   *
   * Scoped by the SAME predicates the list is under (`query`), so the options narrow as the operator
   * narrows: picking a tenant leaves the tag picker offering only tags that tenant's runs actually
   * carry, and a picker never offers a value that would return an empty list.
   *
   * Bounded by {@link RunValueFacetOptions} — read its `scan` note before trusting a `tag` count.
   *
   * Optional: a store that omits it still works — the console falls back to free-text entry for these
   * filters, which is what it had before pickers existed.
   */
  runValueFacets?(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]>;
  listCheckpoints(runId: string): Promise<StepCheckpoint[]>;

  /**
   * The LATEST checkpoint for `runId` whose `name` equals `name` exactly (highest `seq` wins), or
   * `undefined` if none. A targeted read that avoids fetching + deserializing every checkpoint just to
   * keep one match — the store does the filter (`WHERE name = … ORDER BY seq DESC LIMIT 1`). Preserves
   * the "last in seq order wins" semantics the engine relies on for `getEvent` (a re-published key
   * overwrites the prior value at a higher seq, so the highest-seq match is the current value).
   *
   * Optional: a store that omits it still works — the engine falls back to {@link listCheckpoints}
   * plus an in-JS filter that produces the identical result.
   */
  getLatestCheckpointByName?(runId: string, name: string): Promise<StepCheckpoint | undefined>;

  /**
   * All checkpoints for `runId` whose `name` starts with ANY of `prefixes`, ordered by `seq` ascending
   * (same order as {@link listCheckpoints}). A targeted read that avoids scanning every checkpoint just
   * to keep the prefix matches — the store does the filter (`WHERE name LIKE 'prefix%' …`). Used by the
   * run-tree to find a parent's child edges (`signal:child:` / `spawn:` checkpoints) without loading the
   * whole history. An empty `prefixes` array matches nothing.
   *
   * Optional: a store that omits it still works — the engine falls back to {@link listCheckpoints}
   * plus an in-JS prefix scan that produces the identical result.
   */
  listCheckpointsByNamePrefix?(runId: string, prefixes: string[]): Promise<StepCheckpoint[]>;
}

/** The terminal run statuses — a run in one of these is finished and will never change on its own.
 *  Only these are eligible for retention pruning (a {@link RetentionPolicy} targeting a non-terminal
 *  status would race the engine and delete live work). */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'dead',
];

/**
 * One retention rule for hard-pruning terminal run history. Within `statuses` (terminal only), a run
 * is KEPT only if it satisfies EVERY bound you set, and pruned the moment it violates any:
 *  - `maxAge` — prune runs whose `updatedAt` (≈ the time they reached terminal) is older than
 *    `now - maxAge`. A number is milliseconds; a string is an `ms`-style duration parsed by
 *    {@link parseDuration} (`'7d'`, `'2w'`, `'90m'` — note `'m'` is MINUTES; use `'30d'` for a month).
 *  - `maxCount` — keep only the `maxCount` most-recent (by `updatedAt`) runs in the status set; prune
 *    everything past that.
 *
 * Set one or both (both = the most-restrictive wins: capped at `maxCount` rows AND nothing older than
 * `maxAge`). Statuses not named by any policy are never pruned.
 */
export interface RetentionPolicy {
  statuses: RunStatus[];
  maxAge?: number | string;
  maxCount?: number;
}

/** Typed, queryable per-run data — exact values for `eq`/`ne`, numbers/strings for range ops. */
export type SearchAttributes = Record<string, string | number | boolean>;

/**
 * A Standard Schema (https://standardschema.dev — implemented by zod 3.24+, valibot, arktype, …)
 * whose validated OUTPUT is search-attribute-shaped: flat `string`/`number`/`boolean` values only.
 * Declared via `@Workflow({ searchAttributes })`, this makes `ctx.upsertSearchAttributes` reject any
 * write whose merged result doesn't conform. The `Output extends SearchAttributes` bound is enforced
 * structurally at the declaration site — a schema whose inferred output has a nested object/array
 * value (e.g. `z.object({ meta: z.object({ ... }) })`) fails to satisfy this type, so it's a
 * compile-time error to declare it as a `searchAttributes` schema, not a runtime surprise.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 *
 * const orderAttrs = z.object({
 *   tier: z.enum(['free', 'pro']),
 *   amount: z.number(),
 *   rushOrder: z.boolean().optional(),
 * });
 *
 * @Workflow({ name: 'checkout', searchAttributes: orderAttrs })
 * class CheckoutWorkflow {
 *   async run(ctx: WorkflowCtx<InferSearchAttributes<typeof orderAttrs>>, input: CheckoutInput) {
 *     await ctx.upsertSearchAttributes({ tier: input.tier, amount: input.total });
 *   }
 * }
 * ```
 */
export type SearchAttributesSchema<A extends SearchAttributes = SearchAttributes> =
  StandardSchemaV1<unknown, A>;

/** Infer the validated OUTPUT shape of a {@link SearchAttributesSchema} — the typed attributes a
 *  workflow declares via `@Workflow({ searchAttributes })`. Feed it straight into `WorkflowCtx<A>`:
 *  `WorkflowCtx<InferSearchAttributes<typeof mySchema>>`. */
export type InferSearchAttributes<S extends StandardSchemaV1<unknown, SearchAttributes>> =
  StandardSchemaV1.InferOutput<S>;

export type AttributeOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

/** One value a search attribute can hold, and so one operand a predicate compares against. */
export type AttributeValue = string | number | boolean;

/**
 * One predicate over a run's {@link SearchAttributes}; a {@link RunQuery} ANDs them all.
 *
 * The scalar ops carry a single `value`. `in` carries a SET of values matched as OR, and it needs to
 * exist as its own op because ORing inside ONE predicate is the only way to express "tier is pro or
 * enterprise": two `eq` predicates on the same key are ANDed like every other pair, which no run can
 * satisfy. An empty `values` matches nothing, mirroring {@link RunQuery.statuses}.
 */
export type AttributeFilter =
  | { key: string; op: Exclude<AttributeOp, 'in'>; value: AttributeValue; values?: never }
  | { key: string; op: 'in'; values: AttributeValue[]; value?: never };

/** The single-operand members of {@link AttributeFilter} — every op except the `in` set. */
export type ScalarAttributeFilter = Exclude<AttributeFilter, { op: 'in' }>;

export interface RunQuery {
  workflow?: string | undefined;
  /**
   * Match any of these workflows (`workflow IN (...)`). Same shape as {@link statuses}: ORed with
   * each other, ANDed with everything else, and further narrowed by a concurrent single `workflow`.
   * Empty array = matches nothing.
   */
  workflows?: string[] | undefined;
  status?: RunStatus | undefined;
  /**
   * Match any of these statuses (a `status IN (...)` filter). ORed together, and ANDed with the other
   * predicates. Use this instead of issuing one {@link listRuns} call per status — e.g. the singleton
   * admission gate counts `running` + `suspended` in-flight runs in a single scan. If both `status` and
   * `statuses` are set, both must hold (the single `status` further narrows the set). Empty array =
   * matches nothing.
   */
  statuses?: RunStatus[] | undefined;
  /** Only runs carrying this tag (exact match against {@link WorkflowRun.tags}). */
  tag?: string | undefined;
  /**
   * Only runs carrying ANY of these tags. A run's tags are already a set, so the useful multi-value
   * question is "in this set", not "has all of them" — an operator picking `etl` and `nightly` from a
   * facet list means the union, and asking for their intersection through this field would return
   * nothing for tags that never co-occur. ANDed with a concurrent single `tag`; empty = matches nothing.
   */
  tags?: string[] | undefined;
  /**
   * Typed/range predicates over {@link WorkflowRun.searchAttributes}, ANDed together (e.g. `amount`
   * >= 200 and `tier` = 'pro'). Applied in-process after the coarse filters, so pair with
   * `workflow`/`status`/`tag` to bound the scan on large stores.
   */
  attributes?: AttributeFilter[] | undefined;
  /** Restrict to runs in this namespace (exact match), ANDed with the other predicates. */
  namespace?: string | undefined;
  /** Restrict to runs in ANY of these namespaces (`namespace IN (...)`), so a console can compare a
   *  few tenants side by side. ANDed with a concurrent single `namespace`; empty = matches nothing. */
  namespaces?: string[] | undefined;
  /**
   * Restrict to runs whose workflow was declared by this package (exact match against
   * {@link WorkflowRun.origin}), ANDed with the other predicates.
   *
   * A run with NO origin (unknown — see the field) matches no `origin` VALUE at all, so a UI facet
   * built on this must keep an "all origins" option: filtering by any single package silently hides
   * every unattributed run, which reads to an operator as "those runs do not exist". `null` selects
   * exactly that absent bucket (`origin IS NULL`), so a paginated console can offer an "unknown"
   * facet without having to hold every run in the browser to find them.
   */
  origin?: string | null | undefined;
  /**
   * Restrict to runs from ANY of these origins. `null` is a member like any other — it selects the
   * unattributed bucket — so `['@acme/billing', null]` is "this package's runs plus the ones nothing
   * could attribute", which the single {@link origin} cannot express at all. ANDed with a concurrent
   * single `origin`; empty = matches nothing.
   */
  origins?: Array<string | null> | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * The predicates a {@link RunFacetRow} count is taken over — a {@link RunQuery} minus the axes the
 * facets THEMSELVES report (`status`/`origin`) and minus paging. Keeping them out of the type is
 * what makes the counts answerable in one query: a console narrows by tag/tenant/attribute, and the
 * one call back tells it how the matching runs split across every status and every origin at once.
 */
export type RunFacetQuery = Omit<RunQuery, 'status' | 'statuses' | 'origin' | 'limit' | 'offset'>;

/**
 * One `(status, origin)` cell of {@link StateStore.runFacets} — a `GROUP BY` row, not a page of runs.
 * A console pivots these into its status chips and its origin chips, so both stay exact while the
 * list itself is paginated. `origin` is `null` for runs carrying none (see {@link WorkflowRun.origin});
 * that bucket is a real, countable answer here rather than the absence a value-match cannot express.
 */
export interface RunFacetRow {
  status: RunStatus;
  origin: string | null;
  count: number;
}

/**
 * Which axis {@link StateStore.runValueFacets} enumerates the distinct VALUES of. Every member is an
 * axis {@link RunQuery} can then filter by, which is the point: the answer to "what can I pick here"
 * has to be spendable as a predicate, or a console is offering choices that return nothing.
 *
 * `attributeKey` lists the search-attribute keys in use (the left-hand side of a predicate);
 * `attributeValue` lists the values recorded under ONE key (its right-hand side).
 */
export type RunValueAxis =
  | { field: 'workflow' | 'status' | 'origin' | 'namespace' | 'tag' | 'attributeKey' }
  | { field: 'attributeValue'; key: string };

/**
 * One distinct value of a {@link RunValueAxis} and how many of the matching runs carry it — the rows
 * behind a console's value picker. `value` is `null` only where the axis itself has an absent bucket
 * (a run with no `origin`); a count is never zero, since a value with no runs produces no row.
 */
export interface RunValueFacetRow {
  value: string | null;
  count: number;
}

/**
 * The order {@link StateStore.runValueFacets} returns rows in, and the reason a caller can page
 * them: most runs first, ties broken alphabetically, the absent bucket (`null`) last — and tags the
 * engine mints one of per key after everything else, since they otherwise crowd out every tag a
 * human wrote (see `ENGINE_MINTED_TAG_PREFIXES`).
 *
 * Fixed, not incidental: an unordered listing cannot be paged, because page two would be taken over
 * a different arrangement of the same rows and would both repeat and skip.
 */
export type RunValueFacetOrder = 'engine-tags-last, count desc, value asc, null last';

/**
 * How much of the store {@link StateStore.runValueFacets} may read to answer.
 *
 * `limit` bounds the ROWS RETURNED (highest count first): tag and attribute-value cardinality is
 * unbounded in principle — a run tagged `singleton:<key>` mints a new tag per key — so a picker asks
 * for the top slice rather than the whole domain, and keeps free text for everything else.
 *
 * `scan` bounds the RUNS READ, for a store that cannot group an axis in the database and has to
 * count it in memory instead. Those axes report over the newest `scan` matching runs rather than
 * over all of them — a bounded, deliberately approximate answer, where the alternative is a full
 * scan on every keystroke.
 *
 * Which axes those are is a property of the ADAPTER, not of the axis: the column axes are a `GROUP
 * BY` everywhere, and an adapter that can expand a JSON array and join its attribute side table (the
 * MikroORM one does) answers `tag` and the attribute axes exactly too, ignoring `scan` entirely.
 */
export interface RunValueFacetOptions {
  limit?: number | undefined;
  scan?: number | undefined;
  /**
   * How many rows to skip, for a picker that pages as it scrolls. Meaningful only because the
   * ordering is fixed (see {@link RunValueFacetRow}), so page two continues page one instead of
   * re-shuffling it.
   *
   * On an axis answered from a bounded scan rather than a `GROUP BY` (see {@link scan}), paging is
   * over that window: values outside it were never candidates on page one either.
   */
  offset?: number | undefined;
  /**
   * Narrow to values CONTAINING this text, case-insensitively — what a picker's search box sends.
   *
   * Server-side on purpose. A picker that filters an already-fetched page can only search what it
   * happened to receive, so a rare value is unfindable precisely when searching is the only way to
   * reach it: the top slice it was cut from is the reason the operator is typing.
   */
  search?: string | undefined;
}

/** The transaction handle `StateStore.transaction` hands to its work callback. */
export interface StoreTransaction {
  /** The store-native transaction handle (TypeORM `EntityManager`, Prisma tx client, MikroORM `EntityManager`,
   *  Drizzle tx) — do your business DB writes on THIS so they commit atomically with the checkpoint. */
  readonly raw: unknown;
  /** Persist the step checkpoint inside this transaction. */
  saveCheckpoint(checkpoint: StepCheckpoint): Promise<void>;
}

/** Binds an external signal `token` to the suspended run/step position waiting for it. */
export interface SignalWaiter {
  token: string;
  runId: string;
  seq: number;
  /**
   * The parallel-fan group this waiter belongs to, carried from the awaiting command so the resolving
   * `signal:<token>` checkpoint (notably `signal:child:<id>` for an awaited child run) can be tagged
   * with it. A worker's `ctx.gather_children`/`ctx.all` fan-out stamps every `startChild` with the same
   * group; without threading it through the waiter, the child-await checkpoint comes out untagged and the
   * dashboard renders the fan as a sequential chain instead of one parallel group. Undefined for an
   * ordinary (non-fan) signal/child await.
   */
  parallelGroup?: string | undefined;
}

// ---------------------------------------------------------------------------
// Transport — how a remote task travels to a worker and the result returns
// ---------------------------------------------------------------------------

/**
 * A DB-less tenant worker → control plane request to start a run. Published by a worker that has
 * no direct DB access (the hosted-control-plane tenant model) onto the
 * `<effectivePrefix>-start-run` queue; the control plane consumes it and turns it into a durable
 * run (P4 of the tenants plan).
 *
 * The `tenant` identifies the namespace that owns the run (maps to the engine's `namespace`); it
 * is separate from the wire-level key prefix so a single transport can serve multiple tenants.
 */
export interface StartRunMessage {
  tenant: string;
  /** Registered workflow name. */
  workflow: string;
  input: unknown;
  /** Optional caller-supplied run id (idempotency key). The engine generates one if absent. */
  runId?: string | undefined;
  /** Tags to stamp on the run (merged with the workflow's static @Workflow tags). */
  tags?: string[] | undefined;
  /** Typed, queryable run data to stamp on the run (same as {@link StartOptions.searchAttributes}). */
  searchAttributes?: SearchAttributes | undefined;
}

/**
 * A tenant worker → control plane read/control request over the shared transport. Enqueued on
 * `<effectivePrefix>-run-request`; the control plane's `onRunRequest` consumer answers it, scoped to
 * `tenant`, and publishes a {@link RunReply} on `<effectivePrefix>-run-reply` correlated by `requestId`.
 */
export interface RunRequest {
  /** Correlation id minted by the tenant; the matching {@link RunReply} carries it back. */
  requestId: string;
  /** The requesting tenant — the operator scopes the run's namespace to this. */
  tenant: string;
  body: RunRequestKind;
}

/** The discriminated verb + args of a {@link RunRequest}. Mirrors the tenant-facing `RunGateway`. */
export type RunRequestKind =
  | { kind: 'getRunDetail'; runId: string }
  | { kind: 'listRuns'; query: RunQuery }
  | { kind: 'runFacets'; query: RunFacetQuery }
  | {
      kind: 'runValueFacets';
      axis: RunValueAxis;
      query: RunFacetQuery;
      opts?: RunValueFacetOptions | undefined;
    }
  // Per-group worker health — the operator answers it scoped to the requester's own groups (see
  // `RunRequestResponder`), so a tenant's Workers panel shows ITS queues, never another tenant's.
  | { kind: 'workerHealth' }
  | { kind: 'cancel'; runId: string; opts?: { compensate?: boolean } }
  | { kind: 'retry'; runId: string }
  | { kind: 'continue'; runId: string }
  | { kind: 'retryWithInput'; runId: string; input: unknown }
  | { kind: 'redispatch'; runId: string }
  // Bulk, not runId-bearing (like `listRuns`/`workerHealth`) — the operator answers it in one shot
  // and filters the result to runs the requester's tenant actually owns (see `RunRequestResponder`).
  | { kind: 'waitingFor'; runIds: string[] };

/** The control plane's answer to a {@link RunRequest}, correlated by `requestId`. */
export interface RunReply {
  requestId: string;
  result: RunReplyResult;
}

/** Success carries the verb's payload (JSON-serialised); failure carries a re-throwable error. */
export type RunReplyResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { message: string; code?: string } };

/** A lifecycle event re-published to a single tenant's channel (`<effectivePrefix>-tenant-events-<tenant>`)
 *  so a store-less tenant can live-tail ITS OWN runs. Scoped by the run's namespace at publish time. */
export interface TenantEvent {
  tenant: string;
  event: EngineEvent;
}

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
  traceparent?: string | undefined;
  /**
   * Opaque context carrier (tenant / user / correlation ids) the worker re-exposes to the step
   * handler, for cross-process propagation alongside the {@link traceparent}. The engine treats it
   * as a pass-through object and never inspects its shape — the producer (e.g. `@dudousxd/nestjs-context`)
   * owns the keys. Absent when no `context` provider is configured.
   */
  context?: Record<string, unknown> | undefined;
  /**
   * Id of the transport this task was dispatched on (when the engine runs a pool — see
   * {@link NamedTransport}). A worker that consumes several transports replies via the matching one,
   * so failover is symmetric without the worker choosing a transport. Absent for a single transport.
   */
  transport?: string | undefined;
  /**
   * Admission priority carried through to the broker (BullMQ job `priority`) so a transport that
   * supports priority ordering lets an urgent task jump ahead of already-enqueued lower-priority
   * ones at the worker. Mirrors the per-call `priority` from `ctx.step(..., { priority })`. Higher
   * wins; absent means default/unprioritised. Transports without priority support ignore it.
   */
  priority?: number | undefined;
  attempt: number;
}

export interface StepResult {
  runId: string;
  seq: number;
  stepId: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: StepError | undefined;
  /** Epoch ms when the worker began processing — lets the engine report queue-wait time. */
  startedAt?: number | undefined;
  /** Structured events the worker emitted while running the step (sub-step outcomes, logs). */
  events?: StepEvent[] | undefined;
}

export interface Heartbeat {
  runId: string;
  seq: number;
  /**
   * The in-flight step this beat keeps alive. ABSENT for a RUN-scoped (workflow-turn) heartbeat: a
   * worker replaying a long workflow turn beats for its `runId` so the engine rearms the run's
   * `advance` deadline (see `WorkflowEngineDeps.remoteAdvanceSilenceMs`). The engine then keys the
   * liveness reset by `runId` instead of `stepId`.
   */
  stepId?: string | undefined;
  group: string;
}

// ---------------------------------------------------------------------------
// Polyglot workflows — the workflow-task / commands protocol
//
// A workflow authored in a non-TS SDK (e.g. Python) runs coordinator-driven: the engine stays the
// sole owner of the durable state + recovery/timers and advances the run one TURN at a time by
// dispatching a {@link WorkflowTask} (the run's history) to a workflow worker, which REPLAYS the
// function locally and returns a {@link WorkflowDecision} (the commands it produced). The engine
// applies the decision (persist checkpoints, dispatch steps, schedule timers, settle the run). The
// worker never touches the store. See docs/plans/2026-06-15-polyglot-workflows-protocol.md.
// ---------------------------------------------------------------------------

/** engine → workflow worker: advance this run one turn by replaying the function against `history`. */
export interface WorkflowTask {
  /** Dedupe id for this turn (a re-delivered task must be idempotent). */
  taskId: string;
  runId: string;
  /** Registered workflow name + the version the run started on — replay must use that version. */
  workflow: string;
  workflowVersion: string;
  input: unknown;
  /** Completed durable ops so far, ordered by seq — what the worker replays its results from. */
  history: HistoryEvent[];
  /** Signals delivered to the run but not yet consumed, so `wait_signal` resolves on replay. */
  pendingSignals?: Array<{ seq: number; signal: string; payload: unknown }>;
  group: string;
  /** Id of the transport this task was dispatched on (pool failover) — see {@link NamedTransport}. */
  transport?: string;
  traceparent?: string;
  /**
   * Admission priority carried to the broker (BullMQ job `priority`) so an urgent child workflow can
   * jump ahead of already-enqueued lower-priority ones at the worker. Higher wins; absent means
   * default/unprioritised. Transports without priority support ignore it.
   */
  priority?: number | undefined;
  attempt: number;
}

/** One resolved durable op in a run's history — a superset of a completed {@link StepCheckpoint}. */
export interface HistoryEvent {
  seq: number;
  kind: 'step' | 'call' | 'timer' | 'signal' | 'child';
  name?: string | undefined;
  /** Resolved value: a step/call output, a child run's output, a signal payload. */
  output?: unknown;
  /** Set when the op resolved to a failure (e.g. a failed remote step the workflow may catch). */
  error?: StepError | undefined;
}

/** A decision the workflow function produced at a `seq` that was not yet in history. */
export type WorkflowCommand =
  /** `ctx.step(handlerOrName, input)` — dispatch a step (by typed handler reference or by name) and
   *  await it. A worker's `ctx.gather_calls([...])` fan-out tags every dispatched call with the same
   *  `parallelGroup` so the dashboard renders the dispatched steps as one parallel fan (parity with
   *  the gathered `recordStep` / `startChild` tags). Undefined for a lone sequential `ctx.step`. */
  | {
      kind: 'call';
      seq: number;
      name: string;
      group: string;
      input: unknown;
      parallelGroup?: string;
    }
  /** `ctx.step(name, body)` — a LOCAL step the worker already ran this turn; the engine persists its
   *  result so replay returns it instead of re-running (durability for side-effectful work).
   *  `startedAt`/`finishedAt` (epoch ms) carry the step's real wall-clock window so the dashboard
   *  shows a true duration instead of 0ms, and `events` carry the sub-process/log trail the step
   *  emitted (so each handler's p-processes show under it). All optional for back-compat. */
  | {
      kind: 'recordStep';
      seq: number;
      name: string;
      output?: unknown;
      error?: StepError;
      startedAt?: number;
      finishedAt?: number;
      events?: StepEvent[];
      /** A worker's `ctx.gather([...])` tags every step in the parallel fan with the same group, so the
       *  engine carries it onto the checkpoint and the dashboard renders the fan as one group. */
      parallelGroup?: string;
    }
  /** `ctx.sleep(ms)` — a durable timer of `ms` duration. The engine computes the absolute deadline
   *  (now + ms) when it applies the command, so the worker never reads the clock (determinism). */
  | { kind: 'sleep'; seq: number; ms: number }
  /** `ctx.wait_signal(name)` — block until a signal `name` is delivered to the run. */
  | { kind: 'waitSignal'; seq: number; signal: string }
  /** `ctx.start_child(workflow, input)` — start a child run with its own lifecycle. A worker's
   *  `ctx.all([...])` fan-out tags every dispatched child with the same `parallelGroup` so the
   *  dashboard can render the fan as one group (parity with the gathered `recordStep` tag). */
  | {
      kind: 'startChild';
      seq: number;
      workflow: string;
      input: unknown;
      parallelGroup?: string;
    };

/** workflow worker → engine: the result of replaying one turn of a remote workflow. */
export interface WorkflowDecision {
  taskId: string;
  runId: string;
  /** `continue` = produced `commands` and is blocked on an await; otherwise the run settles.
   *  `cancelled` = the worker bailed at an op boundary because the run was cancelled mid-turn. */
  status: 'continue' | 'completed' | 'failed' | 'cancelled';
  /** New durable ops the replay produced this turn (status === 'continue'), ordered by seq. */
  commands: WorkflowCommand[];
  /** Final workflow output (status === 'completed'). */
  output?: unknown;
  /** Terminal error (status === 'failed'). */
  error?: StepError;
}

/**
 * workflow worker → engine: a LOCAL step's lifecycle, streamed AS IT HAPPENS (not batched into the
 * turn's final {@link WorkflowDecision}). A Python `@workflow` runs its `ctx.step`s inline over one
 * turn that can last minutes; without this the engine learns of the steps only when the turn ends,
 * so the dashboard shows nothing mid-run. The worker emits `running` when a step's body starts and
 * `completed`/`failed` when it settles; the engine checkpoints each immediately, so a step appears
 * in-flight and then resolves live. The turn's final `recordStep` command re-persists the same
 * checkpoint idempotently (replay history), so this is purely additive observability.
 */
export interface WorkflowStepEvent {
  runId: string;
  seq: number;
  name: string;
  phase: 'running' | 'completed' | 'failed';
  /** Epoch ms the step body began (all phases) and settled (`completed`/`failed`). */
  startedAt: number;
  finishedAt?: number;
  /** The replayed result / failure for the settled phases. */
  output?: unknown;
  error?: StepError;
  /** Sub-process + log trail the step emitted so far (the handler's p-processes). */
  events?: StepEvent[];
  /** A worker's `ctx.gather([...])` fan tags every step's lifecycle with the same group so the
   *  dashboard renders the live fan-out as one group (parity with the `recordStep` tag). */
  parallelGroup?: string | undefined;
}

/**
 * Advances a workflow run one turn. The engine has one per workflow: the default {@link InProcess}
 * one runs a registered TS function with the in-process replay machinery; a remote one dispatches a
 * {@link WorkflowTask} to a worker (Python) and awaits its {@link WorkflowDecision}. Either way the
 * engine applies the returned decision — so recovery, timers, singleton and dead-letter stay engine
 * concerns, identical for in-process and remote workflows.
 */
export interface WorkflowExecutor {
  /**
   * INLINE replay: advance the turn and RETURN its decision (the in-process executor runs the
   * registered TS function synchronously). The engine awaits this under the run's lease. Provide this
   * OR {@link dispatch} — exactly one. An executor with only `advance` is single-instance by nature
   * (the decision is produced in-process, not delivered over a broker).
   */
  advance?(
    run: WorkflowRun,
    history: HistoryEvent[],
    pendingSignals?: WorkflowTask['pendingSignals'],
  ): Promise<WorkflowDecision>;
  /**
   * DISPATCH-AND-SUSPEND (broker-backed, multi-instance safe): enqueue the turn to a worker under the
   * ENGINE-SUPPLIED `taskId`, WITHOUT awaiting the decision. The engine generates `taskId`, records it
   * on the run as the awaited marker, AND releases the run's lease — all BEFORE calling this — so the
   * worker's {@link WorkflowDecision} (delivered over {@link Transport.onDecision} and applied DURABLY
   * by {@link WorkflowEngine.completeRemoteDecision}, which looks the run up by `decision.runId`) can
   * never arrive ahead of its marker or contend with a still-held lease and be dropped. This method
   * therefore ONLY enqueues — it owns no taskId generation and returns nothing. No in-memory await, so
   * the decision is never lost to a point-to-point broker handing it to a non-dispatching instance.
   * Provide this OR {@link advance} — exactly one.
   */
  dispatch?(
    run: WorkflowRun,
    history: HistoryEvent[],
    taskId: string,
    pendingSignals?: WorkflowTask['pendingSignals'],
  ): Promise<void>;
}

/**
 * A transport in an ordered pool, identified by `id`. The engine dispatches on the first by default
 * and fails over to the next on a dispatch error; a step can pin one via `ctx.step(…, { transport })`.
 * The chosen `id` is stamped on the {@link RemoteTask} so a worker replies through the matching one.
 */
export interface NamedTransport {
  id: string;
  transport: Transport;
}

/**
 * Decides where a freshly-`start`ed run executes. `start` creates the run as `pending` and hands its
 * id here instead of running the body inline — so the API/caller never blocks on workflow execution.
 * The default in-process dispatcher runs it on this instance (a microtask); a broker-backed one
 * enqueues the id for a worker pool to consume (`engine.runOne(runId)`); a no-op one leaves it
 * `pending` in the store for a worker's `runPending` poll to pick up (DB-only, caller-doesn't-execute).
 */
export interface RunDispatcher {
  dispatch(runId: string): void | Promise<void>;
}

export interface Transport {
  /** engine → worker */
  dispatch(task: RemoteTask): Promise<void>;
  /** worker → engine: a step finished (ok or error). */
  onResult(handler: (result: StepResult) => Promise<void>): void;
  /** worker → engine: liveness signal for an in-flight long step. */
  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void;
  /** Release the transport's resources (broker workers, queues, connections) for a clean shutdown.
   *  Optional — an in-process transport has nothing to close. Called on `onApplicationShutdown`
   *  after the engine drains, so a deploy hands off instead of leaving the broker to time out. */
  close?(): Promise<void>;
  /** engine → workflow worker: dispatch a {@link WorkflowTask} (the polyglot-workflow path). Optional
   *  — only transports that carry workflow tasks (BullMQ) implement it; the {@link RemoteWorkflowExecutor}
   *  uses it + {@link onDecision} to advance a remote workflow over the broker. */
  dispatchWorkflowTask?(task: WorkflowTask): Promise<void>;
  /** workflow worker → engine: a replayed turn's {@link WorkflowDecision}. Pair with dispatchWorkflowTask. */
  onDecision?(handler: (decision: WorkflowDecision) => Promise<void>): void;
  /** workflow worker → engine: a LOCAL step's {@link WorkflowStepEvent}, streamed mid-turn so the
   *  engine can checkpoint it live. Point-to-point (a single engine instance consumes each event and
   *  persists it once — no cross-pod duplicate writes). Optional; only broker transports carry it. */
  dispatchStepEvent?(event: WorkflowStepEvent): Promise<void>;
  /** engine ← workflow worker: consume streamed {@link WorkflowStepEvent}s. Pair with dispatchStepEvent. */
  onStepEvent?(handler: (event: WorkflowStepEvent) => Promise<void>): void;
  /** Worker-health for a group: queue backlog + live worker heartbeats. Optional — only broker
   *  transports (BullMQ) that can introspect the task queue and the worker-heartbeat keys implement
   *  it. The engine aggregates this across its groups in {@link WorkflowEngine.workerHealth}. */
  groupHealth?(group: string): Promise<GroupHealth>;
  /** Distinct groups that currently have a live worker heartbeat — discovered from the heartbeat
   *  keyspace, so a group with workers but no engine-side registration (e.g. a local-step group)
   *  still surfaces. Pairs with {@link groupHealth}. */
  listWorkerGroups?(): Promise<string[]>;
  /**
   * The live handshake {@link WorkerDescriptor}s advertised for `group` (design §7.2). Optional — only
   * broker transports that carry the two-tier descriptor advertisement (BullMQ) implement it; a pure
   * in-process transport returns nothing, so the engine's routing guard stays disengaged (legacy
   * assume-compatible, design §7.7). The engine feeds these into {@link planDispatch} to decide whether
   * a run can dispatch to `group` or must park `blocked`.
   */
  readWorkerDescriptors?(group: string): Promise<WorkerDescriptor[]>;
  /**
   * Every live {@link WorkerDescriptor} in the deployment, across all groups — the read behind
   * {@link WorkflowEngine.announcedWorkflows}. Optional, same as {@link readWorkerDescriptors}: a
   * transport that cannot introspect the advertisement keyspace returns nothing and the registry is
   * simply empty.
   *
   * Deliberately NOT `listWorkerGroups()` + a read per group: a worker publishes the SAME descriptor
   * under every token it consumes, so per-group reads cost one round trip per group to re-fetch bytes
   * the caller already has. One pass over the advertisement keyspace, de-duplicated by `instanceId`,
   * answers with one scan and no per-group fan-out — and it also sees an instance whose groups the
   * caller could not have enumerated.
   */
  readAllWorkerDescriptors?(): Promise<WorkerDescriptor[]>;
  /**
   * Every live worker heartbeat in the deployment, across all groups — the LIVENESS floor under
   * {@link WorkflowEngine.workflowDirectory}. Optional, same as {@link readAllWorkerDescriptors}.
   *
   * It exists because a descriptor is the richer advertisement but not the universal one: an SDK
   * that predates the handshake beats a liveness key and publishes no descriptor at all, and reading
   * only descriptors reports such a fleet as EMPTY while it is serving work. Convention routing
   * already resolves those workers off exactly these keys, so a directory built without them
   * contradicts the dispatcher standing next to it.
   *
   * Distinct from {@link listWorkerGroups}, which answers with tokens alone: this carries the
   * instance behind each one, so the directory can say how many workers back a name and a partition
   * sighting can name who is beating there.
   */
  readAllWorkerHeartbeats?(): Promise<WorkerHeartbeat[]>;
  /**
   * DB-less tenant worker → control plane: publish a {@link StartRunMessage} requesting a new run.
   * Optional — only transports that carry the hosted-control-plane protocol (P4) implement this.
   * The message is enqueued on `<effectivePrefix>-start-run`; the control plane's
   * `onStartRun` consumer turns it into a durable run.
   */
  dispatchStartRun?(msg: StartRunMessage): Promise<void>;
  /**
   * control plane ← tenant worker: consume {@link StartRunMessage}s and start runs. Pair with
   * {@link dispatchStartRun}. Optional — only control-plane-side transports implement this.
   */
  onStartRun?(handler: (msg: StartRunMessage) => Promise<void>): void;
  /**
   * Tenant worker → control plane: publish a {@link RunRequest} (read/control) on
   * `<effectivePrefix>-run-request`. Optional — only broker transports carry it.
   */
  dispatchRunRequest?(msg: RunRequest): Promise<void>;
  /** control plane ← tenant worker: consume {@link RunRequest}s. Pair with {@link dispatchRunRequest}. */
  onRunRequest?(handler: (msg: RunRequest) => Promise<void>): void;
  /** control plane → tenant worker: publish a correlated {@link RunReply} on `<effectivePrefix>-run-reply`
   *  (pub/sub; every tenant subscribes and filters by `requestId`). */
  publishRunReply?(reply: RunReply): Promise<void>;
  /** tenant worker ← control plane: consume {@link RunReply}s (filter by `requestId` client-side). */
  onRunReply?(handler: (reply: RunReply) => void): void;
  /** control plane → tenant worker: re-publish a lifecycle {@link TenantEvent} on the run's per-tenant
   *  channel `<effectivePrefix>-tenant-events-<tenant>`. */
  publishTenantEvent?(evt: TenantEvent): Promise<void>;
  /** tenant worker ← control plane: subscribe to THIS tenant's event channel. Returns an unsubscribe fn. */
  onTenantEvent?(tenant: string, handler: (evt: TenantEvent) => void): () => void;
}

/** How a worker decides its concurrency, carried in {@link WorkerStatus} so a dashboard can tell a
 *  fixed knob from a self-regulating one (and, for the latter, where the controller currently sits). */
export interface WorkerConcurrencyStatus {
  /** `fixed` = the configured `concurrency` number, never moves. `adaptive` = the controller tunes it. */
  mode: 'fixed' | 'adaptive';
  /** The concurrency ceiling in effect right now (fixed: the configured value; adaptive: the live limit). */
  limit: number;
  /** Adaptive only — the floor the controller won't go below. */
  min?: number;
  /** Adaptive only — the ceiling the controller won't exceed. */
  max?: number;
}

/** The adaptive controller's most recent limit change — the "why did it move" a dashboard shows so an
 *  auto-tuner isn't a black box. Absent until the controller first adjusts (or for a fixed worker). */
export interface WorkerAdjust {
  /** Epoch ms of the adjustment. */
  at: number;
  /** Limit before this change. */
  from: number;
  /** Limit after this change. */
  to: number;
  /** Why it moved: `ram_ceiling` (hard brake), `backpressure` (errors/stall), `grow` (had headroom),
   *  `shrink` (latency gradient showed queuing), `cpu_ceiling`. */
  reason: 'ram_ceiling' | 'cpu_ceiling' | 'backpressure' | 'grow' | 'shrink';
}

/** A live snapshot of a worker's execution state, carried in the worker-liveness heartbeat (so it
 *  rides the existing TTL'd key — no extra round-trip) and surfaced per worker in the dashboard. Every
 *  field beyond {@link concurrency}/{@link inFlight} is best-effort: a field a runtime can't measure is
 *  simply omitted. The shape is shared by the TS and Python SDKs so a mixed-language group reports
 *  uniformly. */
export interface WorkerStatus {
  /** Which SDK is running this worker — `node` (TS) or `python`. */
  runtime?: 'node' | 'python';
  /** The worker's concurrency knob and its live ceiling. */
  concurrency: WorkerConcurrencyStatus;
  /** Tasks executing right now (0..limit). With `limit`, this is the saturation a dashboard charts. */
  inFlight: number;
  /** Resident set size in bytes, if the runtime can read it. */
  rssBytes?: number;
  /** The process memory ceiling in bytes (cgroup `memory.max`, else host total), if known. */
  rssLimitBytes?: number;
  /** RSS as a percent of {@link rssLimitBytes} (0..100) — what the adaptive RAM brake watches. */
  rssPct?: number;
  /** Process CPU utilisation percent over the last control tick (0..100×cores), if measured. */
  cpuPct?: number;
  /** Completed tasks per minute over the recent window — the controller's throughput signal. */
  throughputPerMin?: number;
  /** p95 of recent task durations in ms — the latency a dashboard charts against the limit. */
  p95Ms?: number;
  /** The adaptive controller's last limit change (absent for a fixed worker or before the first move). */
  lastAdjust?: WorkerAdjust;
}

/** One worker's liveness record — a TTL'd heartbeat a worker refreshes while it's consuming. Its
 *  ABSENCE (the key expired) is the signal: a worker that died or stalled stops refreshing. */
export interface WorkerHeartbeat {
  /** The worker group this instance serves (e.g. `pipeline`, `processing-workflows`). */
  group: string;
  /** Stable per-process id (host + pid), so N replicas of a group each show as a distinct worker. */
  instanceId: string;
  /** Epoch ms of the worker's most recent heartbeat. */
  lastBeatAt: number;
  /** The worker's live execution snapshot, when its heartbeat carries one (newer SDKs stamp a JSON
   *  value; an older SDK's bare-timestamp heartbeat leaves this undefined). */
  status?: WorkerStatus;
}

/** Per-group worker-health snapshot: how much work is queued vs. how many workers are alive to do it.
 *  The actionable alert state is `depth > 0 && liveWorkers.length === 0` — work piling up with no
 *  consumer (exactly the failure where a worker is "alive but not consuming"). */
export interface GroupHealth {
  group: string;
  /** Outstanding jobs in the group's task queue (waiting + active + delayed + prioritized). */
  depth: number;
  /** Workers with a non-expired heartbeat for this group. */
  liveWorkers: WorkerHeartbeat[];
  /**
   * Whether this group serves a `@Workflow` body or a `@Step`/handler — route-by-handler gives each
   * its own queue, so a health list mixes both. Classified by the CONTROL PLANE from its authoritative
   * registry (`workerHealth()`): a group whose base name is a registered workflow is `'workflow'`,
   * everything else (in-process steps, remote `handle_*`) is `'step'`. `undefined` only when no
   * control-plane registry was available to classify (e.g. a transport that reports health with no
   * engine). Lets a dashboard summarise the fleet in domain terms ("N workflows · M steps") instead of
   * leaking the raw queue count.
   */
  kind?: 'workflow' | 'step';
}

/**
 * The **control plane** — a broadcast pub/sub across ALL engine instances (every pod), separate
 * from the {@link Transport}'s point-to-point work queues (`dispatch`/`onResult`). It carries what
 * every instance may need regardless of who runs a given run: lifecycle events (so a dashboard-only
 * pod can live-tail a run executing on a worker pod) and cancellation (so the pod actually running a
 * run learns it was cancelled elsewhere). In-process implementations broadcast locally; a
 * cross-process one (BullMQ) fans out over its broker (Redis pub/sub). Give the engine a
 * `controlPlane` to enable cross-instance events/cancellation; omit it and the engine is local-only.
 * A transport that can broadcast may implement this too and be passed as both.
 */
export interface ControlPlane {
  publishControl(msg: ControlMessage): Promise<void>;
  onControl(handler: (msg: ControlMessage) => void): void;
}

/** A message on the {@link ControlPlane}. `from` is the originating engine's `instanceId`, so a
 *  broker that echoes a publish back to its own subscriber (e.g. Redis pub/sub) can be deduped by
 *  the originator. */
export type ControlMessage = { from?: string } & (
  | { kind: 'event'; event: EngineEvent }
  | { kind: 'cancel'; runId: string }
  // A run was just enqueued — nudge worker instances to pick it up now instead of on the next poll.
  | { kind: 'enqueued'; runId: string }
);

// ---------------------------------------------------------------------------
// Authoring — workflows, local steps, and typed remote steps
// ---------------------------------------------------------------------------

export type BackoffStrategy = 'fixed' | 'exp';

/**
 * Options for `ctx.child` / `ctx.startChild`. A bare string passed instead is shorthand for
 * `{ childId }`, so the existing `ctx.child(ref, input, 'my-id')` form keeps working.
 */
export interface ChildCallOptions {
  /** Deterministic child run id; defaults to one derived from the parent run id + call position. */
  childId?: string | undefined;
  /**
   * Pin the child to this EXACT registered version instead of the newest one — the same contract as
   * `StartOptions.version`, reached from inside a workflow body: an unregistered version fails the
   * child's start rather than quietly running a different body, and a version can only be pinned on a
   * workflow that is really registered (not on the synthesized remote/convention routes). A `ctx.child`
   * whose pinned start fails surfaces it as a failed child on the parent's waiter; a fire-and-forget
   * `ctx.startChild` buffers it until the parent joins the id.
   *
   * Replay-safe as long as you pass a CONSTANT (`{ version: '2' }`), which is the point — it names the
   * body you meant. Computing it from a live registry read at call time would make the body
   * non-deterministic, exactly like reading the clock.
   */
  version?: string | undefined;
  /**
   * Dispatch priority for a REMOTE child workflow — stamped on the child run and carried onto every
   * {@link WorkflowTask} dispatched to advance it, so an urgent child can jump ahead of enqueued
   * lower-priority ones at the worker. Higher wins; absent = unprioritised. Ignored for an in-process
   * (TS class) child, which runs in the engine and never hits a broker queue.
   */
  priority?: number | undefined;
}

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
   * Liveness window for a dispatched step (`ctx.step`): if the worker produces no result and no
   * heartbeat within this many ms, the engine presumes it dead and fails the dispatch with a
   * `RemoteStepTimeout` (retryable — it re-dispatches per `retries`). Each heartbeat resets the
   * window. Omit to wait indefinitely.
   */
  timeoutMs?: number;
  /**
   * Capabilities a live worker MUST advertise to run this dispatched step (handshake design §7.5).
   * The control-plane routes the step only to workers whose descriptor advertises every name here;
   * if descriptors are published on the step's group but NONE is capability-capable + protocol-
   * compatible, the run parks `blocked` (never a silent hang) and the blocked-recovery poll re-drives
   * it when a capable worker appears. Absent/empty = "runs anywhere" (the default; backward-compatible
   * — a legacy fleet publishing no descriptors skips the guard entirely, design §7.7).
   */
  requires?: string[];
  /**
   * Saga compensation: if this step completes but the run later **fails**, the engine runs the
   * registered `compensate` callbacks in reverse order (undo what was done). Local steps only.
   * Idempotency note: a step is already deduplicated by its deterministic `stepId` (runId:seq) —
   * remote workers can use it as the idempotency key, so there's no separate key option.
   */
  compensate?: () => Promise<void>;
}

/**
 * The structural carrier a dispatched `ctx.step` call resolves to and hands the engine: `name` is
 * the routing contract (the worker registers a handler under the same name, and routing is BY that
 * name — a worker subscribes per registered handler name, not a hand-declared group). There is no
 * public factory for this anymore — a `ctx.step(ref, input)` call builds one internally from the
 * `@Step`-stamped name (see {@link StepRef}/`stepNameOf`); a `ctx.step(name, input)` call builds one
 * from the literal string. `input`/`output` are optional runtime zod schemas an authoring layer MAY
 * attach (e.g. `@Step({ input, output })`) for validation at the dispatch boundary — a bare `@Step()`
 * carries neither, and the engine skips validation when they're absent.
 */
export interface StepDef<TInput = unknown, TOutput = unknown> extends StepOptions {
  name: string;
  /** Optional isolation partition; routing is by `name`. Suffixes the routing token as
   *  `<name>@<partition>` (via {@link tenantGroup}) — omit to route by the bare (sanitized) `name`. */
  partition?: string | undefined;
  input?: z.ZodType<TInput> | undefined;
  output?: z.ZodType<TOutput> | undefined;
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
  readonly url?: string | undefined;
  /**
   * Suspend until the callback arrives, then resume with its payload. Waits indefinitely by default —
   * no compute consumed. Pass `{ timeoutMs }` to bound the wait: if the deadline passes first the call
   * throws a `SignalTimeoutError` (catch it in the workflow to branch) — same timeout semantics as
   * {@link WorkflowCtx.waitForSignal}. The deadline is computed once (on the first call) and persisted,
   * so a replay reuses the recorded deadline rather than recomputing it from the current clock.
   */
  wait(opts?: { timeoutMs?: number }): Promise<TPayload>;
}

/**
 * Options for a dispatched {@link WorkflowCtx.step} call. `retries`/`backoff`/`backoffMs`/
 * `backoffMaxMs`/`jitter`/`timeoutMs` are a PER-CALL override of the `@Step`-declared
 * {@link StepConfig} (see `stepConfigOf`) — the effective policy `ctx.step` builds into the dispatched
 * {@link StepDef} is `{ ...stepConfigOf(ref), ...opts }`, so a call-site value wins field-by-field. The
 * string (cross-runtime) form of `ctx.step` has no stamped `@Step` to read, so it uses these fields
 * as-is.
 */
export interface StepDispatchOpts {
  /** Subject the dispatch to a registered flow-control queue (concurrency / rate limit). */
  queue?: string;
  /** Admission priority within `queue`; higher is admitted first when a slot is contended
   *  (default 0). No effect without a `queue`. */
  priority?: number;
  /** The fairness bucket for a queue with `fairness: 'key'` (e.g. a tenant id) — the queue
   *  round-robins across distinct keys so one key can't monopolize the budget. Defaults to the run
   *  id when omitted. No effect without a `queue`. */
  fairnessKey?: string;
  /** Pin the dispatch to a named transport in the pool (else the pool's first, with failover to the
   *  rest). See `engine.registerQueue` / the engine's `transports` option. */
  transport?: string;
  /** Max attempts before the step (and run) fails. Overrides the `@Step`-declared value. */
  retries?: number;
  /** How the delay between retries grows: `fixed` (constant) or `exp` (doubles each attempt).
   *  Overrides the `@Step`-declared value. */
  backoff?: BackoffStrategy;
  /** Base delay in ms between retries. Omit (or 0) to retry with no delay. Overrides the
   *  `@Step`-declared value. */
  backoffMs?: number;
  /** Upper bound on the (exponential) backoff delay. Overrides the `@Step`-declared value. */
  backoffMaxMs?: number;
  /** Add random jitter (50–100% of the computed delay) to avoid thundering-herd retries. Overrides
   *  the `@Step`-declared value. */
  jitter?: boolean;
  /** Liveness window for this dispatched step: no result/heartbeat within this many ms presumes the
   *  worker dead and fails the dispatch with a `RemoteStepTimeout` (retryable — re-dispatches per
   *  `retries`). Omit to wait indefinitely. Overrides the `@Step`-declared value. */
  timeoutMs?: number;
  /** Capabilities a live worker must advertise to run this dispatch (handshake design §7.5). Overrides
   *  the `@Step`-declared `requires`. Absent = inherit the def-level value (or "runs anywhere"). */
  requires?: string[];
}

/** What a saga undo handler receives: the compensated step's original input and its result — the
 *  ONE argument a compensation `@Step` is called with, so it's self-describing on the wire (a
 *  Python worker sees `{ input, output }` with no side-channel lookup needed). */
export interface StepUndo<TInput, TOutput> {
  input: TInput;
  output: TOutput;
}

/**
 * Derive a `ctx.step` compensation handler's expected argument from the ORIGINAL step's method
 * type, so the ref form is compile-checked against the step it undoes:
 *
 * ```ts
 * async cancelBooking(undo: UndoOf<FlightService['book']>) { ... }
 * ```
 *
 * `...rest: never[]` pins this to a single-argument method (the shape every `@Step` handler has —
 * see {@link StepRef}); `Awaited<R>` unwraps a `Promise<TOutput>` return down to `TOutput`.
 */
export type UndoOf<H> = H extends (input: infer I, ...rest: never[]) => infer R
  ? StepUndo<I, Awaited<R>>
  : never;

/**
 * The context handed to a workflow function. Every interaction with the outside world goes
 * through it so the engine can checkpoint — the workflow body itself stays deterministic.
 *
 * Generic over `A`, the run's {@link SearchAttributes} shape — narrows {@link upsertSearchAttributes}
 * when a workflow declares a `@Workflow({ searchAttributes })` schema (pass
 * `WorkflowCtx<InferSearchAttributes<typeof mySchema>>` as the `run` method's ctx type). Defaults to
 * the untyped `SearchAttributes`, so every existing `WorkflowCtx` usage is unaffected.
 */
export interface WorkflowCtx<A extends SearchAttributes = SearchAttributes> {
  readonly runId: string;
  /**
   * Run a durable step — always dispatched, always engine-scheduled: the ONE step primitive (no
   * local/remote placement choice). Pass the step's method **reference** (a `@Step`-decorated
   * method, typed by its own signature — refactor-safe, autocompleted):
   *
   * ```ts
   * const r = await ctx.step(this.extraction.runExtractionPage, { page, key });
   * ```
   *
   * or its **name** for a cross-runtime handler (no JS reference to import, e.g. a Python `@step`):
   *
   * ```ts
   * const out = await ctx.step<ProcResult>('processing:proc', input);
   * ```
   *
   * Both forms dispatch identically — a step runs on whatever worker serves that name and the run
   * suspends (zero compute) until the result lands, then resumes with it (durable, replay-safe).
   *
   * `opts.compensate` registers a SAGA UNDO for this call, dispatched (durably, in reverse order
   * with every other registered undo) if the run later fails or is cancelled with
   * `{ compensate: true }`. The undo is itself a normal `@Step` — pass its reference (compile-time
   * checked: it must accept `StepUndo<TInput, TOutput>` of THIS call, see {@link UndoOf}) or its
   * name for a cross-runtime undo handler. It runs on whatever worker serves that name, called with
   * the ONE `{ input, output }` envelope — never the original handler re-invoked in-process.
   */
  step<TInput, TOutput>(
    handler: StepRef<TInput, TOutput>,
    input: TInput,
    opts?: StepDispatchOpts & { compensate?: StepRef<StepUndo<TInput, TOutput>, unknown> | string },
  ): Promise<TOutput>;
  step<TOutput = unknown, TInput = unknown>(
    name: string,
    input: TInput,
    opts?: StepDispatchOpts & { compensate?: StepRef<StepUndo<TInput, TOutput>, unknown> | string },
  ): Promise<TOutput>;
  /**
   * **Exactly-once** durable step for DB work: runs `fn` and writes the step's checkpoint in ONE
   * store transaction, so the business write and the "done" marker commit atomically — a crash can
   * never leave the write done-but-not-checkpointed (which a plain `ctx.step` would re-run). `fn`
   * receives the store-native transaction handle (`tx` — a TypeORM/MikroORM `EntityManager`, a Prisma
   * tx client, or a Drizzle tx); do your writes on it. Needs a SQL store that supports transactions
   * (the bundled SQL adapters do); throws otherwise.
   */
  transaction<TOutput>(name: string, fn: (tx: unknown) => Promise<TOutput>): Promise<TOutput>;
  /**
   * Call a durable **entity** op and await its result — the entity (`engine.registerEntity`) runs the
   * op serialized per `key` over durable state. e.g. `await ctx.callEntity('cart', userId, 'add', item)`.
   */
  callEntity<TResult = unknown>(
    name: string,
    key: string,
    op: string,
    arg?: unknown,
  ): Promise<TResult>;
  /** Send a durable entity op without awaiting a result (fire-and-forget, dispatched once). */
  signalEntity(name: string, key: string, op: string, arg?: unknown): Promise<void>;
  /**
   * Durable sleep: suspends the run for `duration` (e.g. `'30s'`, `'2h'`, `'7 days'`, or ms as a
   * number) without consuming resources, resuming automatically once the timer is due — even
   * across restarts.
   */
  sleep(duration: string | number): Promise<void>;
  /**
   * Durable sleep until an **absolute** time (a `Date` or epoch ms) — like {@link sleep} but for a
   * fixed deadline (e.g. "resume at midnight"). Resumes automatically once the time passes, across
   * restarts. The recorded wake time is fixed on the first run, so it's replay-stable.
   */
  sleepUntil(when: Date | number): Promise<void>;
  /**
   * End this run and **continue as a fresh execution** of the same workflow with `input` and a clean
   * history — for long-running / looping workflows that would otherwise accumulate unbounded
   * checkpoints (and slow replays). The next run gets id `<runId>~N`. Terminal: it always throws, so
   * code after it never runs. Carry forward whatever state the next iteration needs in `input`.
   */
  continueAsNew(input?: unknown): Promise<never>;
  /**
   * Suspend the run until an external `engine.signal(token, payload)` arrives (e.g. a webhook or
   * human approval), then resume with the payload. Waits indefinitely by default — no compute
   * consumed. Pass `{ timeoutMs }` to bound the wait: if the deadline passes first the call throws
   * a `SignalTimeoutError` (catch it in the workflow to branch).
   */
  waitForSignal<TPayload>(token: string, opts?: { timeoutMs?: number }): Promise<TPayload>;
  /**
   * Wait for a named **event** published via `engine.publishEvent(name, payload)`, then resume with
   * the payload. Unlike a signal (point-to-point by token), events are name-based pub/sub: pass an
   * optional `match` (a subset of the payload that must deep-equal) so a publish fans out only to the
   * runs it concerns — e.g. `ctx.waitForEvent('payment.settled', { match: { orderId } })`. `timeoutMs`
   * bounds the wait (throws `SignalTimeoutError`). No compute consumed while waiting.
   */
  waitForEvent<TPayload>(
    name: string,
    opts?: { match?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<TPayload>;
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
   * Run another registered workflow as a **tracked child** and await its result: starts it once and
   * suspends — zero compute — until the child reaches a terminal state, then resumes with the child's
   * output (or throws a FatalError if the child failed). `childId` defaults to a deterministic id
   * derived from this run and the call position, so it's stable across replay.
   *
   * Pass the child's **class** (`ctx.child(ShippingWorkflow, input)`) for a typed input + result; pass
   * a **string** name for a cross-runtime child (e.g. a Python workflow) where there's no class.
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
  /**
   * Start a child workflow **fire-and-forget**: dispatches it once (checkpointed, replay-safe) and
   * returns its run id immediately — the parent keeps running instead of suspending. Use it to kick
   * off side work (an audit log, a notification) you don't need to wait on, or to fan out: collect
   * the ids, then later `await ctx.child(...)` each with the same id to join (the start is idempotent
   * by id, so the child runs exactly once). Class or string ref, like {@link child}.
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
  /**
   * Run N children of the SAME workflow **in parallel** and wait for ALL of them: dispatches one
   * child per entry in `inputs` (concurrently, each with its own durable lifecycle), suspends — zero
   * compute — until every child reaches a terminal state, then resumes with their outputs in **input
   * order**. Child ids are group-scoped and stable (`<runId>.all.<firstSeq>.<i>`), and the running
   * placeholders share a `parallelGroup` tag so the dashboard renders the fan-out as one group.
   *
   * `mode` (default `waitAll`): `waitAll` waits for all then throws an aggregate {@link GatherError}
   * if any failed; `failFast` throws as soon as a failed child is seen, and requests cancellation of
   * every sibling that hasn't completed yet (best-effort, plain cancel — no saga undo; a sibling
   * mid-step only observes it at its next checkpoint, it isn't force-killed mid-synchronous-execution,
   * so a fast sibling can still slip through and complete). Empty `inputs` returns `[]` with no side
   * effects. The wait-all / fan-out counterpart to {@link child}; parity with the Python SDK's
   * `gather_children`.
   */
  all<C extends WorkflowClass>(
    workflow: C,
    inputs: WorkflowInputOf<C>[],
    opts?: { mode?: 'waitAll' | 'failFast' },
  ): Promise<WorkflowOutputOf<C>[]>;
  all<TOutput = unknown>(
    workflow: string,
    inputs: unknown[],
    opts?: { mode?: 'waitAll' | 'failFast' },
  ): Promise<TOutput[]>;
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
   * Deterministic wall-clock, epoch **milliseconds** (like `Date.now()`): records the time on the
   * first run and replays the SAME value afterwards. Use this instead of `Date.now()`/`new Date()`
   * inside a workflow — a raw clock read returns a different value on every replay, which silently
   * corrupts a durable run. Returns a number so it composes in arithmetic (deadlines, elapsed);
   * for an ISO string do `new Date(await ctx.now()).toISOString()`. Every step is dispatched now
   * (see {@link step}), so a trivial timestamp capture gets this lightweight deterministic helper
   * instead of a full `@Step` + worker round-trip.
   */
  now(): Promise<number>;
  /**
   * **Deterministic capture.** Run `fn` once, checkpoint its result, and on replay return the SAME
   * value WITHOUT re-running `fn` — the durable way to bring a non-deterministic value into a workflow
   * where you control the generator: `ctx.sideEffect(() => uuidv7())`, `() => ulid()`,
   * `() => Math.random()`, a config/env read. Prefer a {@link step} for real work with side effects
   * (a DB write, an API call): `fn` here runs only once and MUST be effectively pure (it produces a
   * value; it is not re-executed on replay), like Temporal's `sideEffect`. For a plain timestamp use
   * {@link now}.
   */
  sideEffect<TValue>(fn: () => TValue | Promise<TValue>): Promise<TValue>;
  /**
   * Merge `attrs` into THIS run's {@link WorkflowRun.searchAttributes} — the indexed metadata the
   * dashboard and {@link RunQuery} filter on. Shallow merge: keys you don't pass are kept. Durable +
   * exactly-once — recorded at this position on the first run and SKIPPED on replay, so it does one
   * write, not one per turn. Use this instead of injecting the {@link StateStore} to mutate the run
   * you're executing (`@Inject(state-store)` + `store.updateRun(ctx.runId, …)` becomes
   * `ctx.upsertSearchAttributes(…)`).
   *
   * When the workflow declares a `@Workflow({ searchAttributes })` schema, the MERGED result (this
   * run's existing `searchAttributes` shallow-merged with `attrs`) is validated against it before the
   * write — an invalid merge throws, naming the workflow, the offending key(s), and the schema's
   * issues. Validation runs once, on the same first-run-only position as the write itself (skipped
   * entirely on replay, so it's never a source of nondeterminism); it must be synchronous — a schema
   * whose `validate` returns a `Promise` throws instead of being awaited. No schema declared ⇒
   * unchanged, unvalidated behavior.
   */
  upsertSearchAttributes(attrs: Partial<A>): Promise<void>;
  /**
   * Run a checkpointed step **in-process** — the escape hatch from the always-dispatched {@link step}
   * for work that must run inline in the workflow body. Like `step`, its result is a durable checkpoint
   * (returned, not re-run, on replay); unlike `step`, the body `fn` executes here rather than on a
   * worker, so it can carry an in-memory `compensate` callback for **sagas** — an undo the engine runs
   * in reverse if the run later fails (see [Sagas & compensation](/docs/reliability/sagas)). `fn`
   * receives a {@link StepLogger} for sub-process events. Prefer {@link step} for ordinary work; reach
   * for `localStep` when you need in-process execution or a compensation.
   */
  localStep<TOutput>(
    name: string,
    fn: (log: StepLogger) => Promise<TOutput>,
    options?: StepOptions,
  ): Promise<TOutput>;
}

/** Result of executing or resuming a workflow run. */
export interface RunResult {
  runId: string;
  status: RunStatus;
  output?: unknown;
  error?: StepError | undefined;
}

/**
 * Validates an incoming `engine.update` before it is delivered to the run. Throw (or return a
 * non-empty string) to reject — the run is left untouched. Return nothing/void to accept. May be
 * async (e.g. a business-rule check against a DB).
 */
// A validator may return nothing (accept) or a reason string (reject); `void` is the intended
// "returned nothing" case, sync or async.
export type UpdateValidator<TArg = unknown> =
  // biome-ignore lint/suspicious/noConfusingVoidType: `void` here means "returned nothing" (accept).
  (arg: TArg) => void | string | Promise<void | string>;

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
  | 'step.failed'
  // A single step event (log line / sub-process outcome) emitted WHILE a step is still running, so
  // observers tail a long step's progress live instead of waiting for `step.completed` to deliver
  // the whole `events` array at once. Carries `event`; never persisted (live-tail only).
  | 'step.progress'
  // A run parked `blocked`: no live worker on its next-dispatch group is capability-capable +
  // protocol-compatible (handshake design §7.5/§7.6). Carries the structured `diagnostics` delta
  // (which capability/protocol gap, both descriptors) so the dashboard health panel + telescope
  // timeline render exactly WHY — never a bare boolean. The `error.code` is the machine code
  // (`capability.unavailable` / `protocol.incompatible`).
  | 'run.blocked';

/**
 * A lifecycle event emitted by the engine. The observability surfaces (dashboard, OTel, the
 * Telescope integration) all subscribe to these rather than reaching into the store.
 */
export interface EngineEvent {
  type: EngineEventType;
  runId: string;
  workflow?: string | undefined;
  /** The run's worker-pool partition (see {@link WorkflowRun.namespace}), stamped on the `run.*`
   *  lifecycle events (where the emitting call site already has the run in hand) so a tenant-event
   *  re-publisher can scope without a per-event store read. Absent on `step.*` events. */
  namespace?: string | undefined;
  seq?: number | undefined;
  name?: string | undefined;
  kind?: StepKind | undefined;
  output?: unknown;
  error?: StepError | undefined;
  /** Wall-clock duration of the unit that just finished (step or run), when known. */
  durationMs?: number | undefined;
  /** For a remote step: how long it waited in the queue before a worker picked it up. */
  queueMs?: number | undefined;
  /** The live step event carried by a `step.progress` (the single log line / sub-process outcome a
   *  running step just emitted). Absent on lifecycle events. */
  event?: StepEvent | undefined;
  /** Capabilities the blocked dispatch required (on a `run.blocked` event). */
  requires?: string[] | undefined;
  /** The structured routing delta on a `run.blocked` event (design §7.6): which capability/protocol
   *  gap fired, how many live workers were considered, and both descriptors — enough for the health
   *  panel/telescope to render the reason. Absent on all other event types. */
  diagnostics?: DispatchDiagnostics | undefined;
  at: Date;
}

export type EngineListener = (event: EngineEvent) => void;

/** What a {@link StepInterceptor} is told about the local step it is wrapping. */
export interface StepInvocation {
  readonly runId: string;
  readonly workflow: string;
  /** The step name passed to `ctx.step(name, ...)` (also `'now'`/`'random'`/`'uuid'` internals). */
  readonly stepName: string;
  /** The step's logical position within the run. */
  readonly seq: number;
  /** 1-based attempt number — increments across `ctx.step` retries. */
  readonly attempt: number;
}

/**
 * Wraps the **real execution** of a local `ctx.step` (Template/Nest-style onion middleware). Call
 * `next()` to run the step body (or the next interceptor) and return — or transform — its result;
 * throw to fail the step. First-registered runs outermost. Interceptors fire only when a step
 * actually executes, NOT on replay (a replayed step returns its recorded output without running),
 * so they see true execution timing. Register with `engine.use`.
 */
export type StepInterceptor = (
  invocation: StepInvocation,
  next: () => Promise<unknown>,
) => Promise<unknown>;
