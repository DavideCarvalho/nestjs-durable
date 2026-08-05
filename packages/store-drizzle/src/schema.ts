import { getTableName } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// SQLite / libSQL schema for the durable tables. Timestamps and `wakeAt` are epoch-ms integers
// (SQLite has no native date type). Import these tables and pass them with your drizzle db.

/** The namespace a run belongs to when its creating engine named none. Matches the column DEFAULT
 *  below, the MikroORM adapter's `default: 'default'`, and the in-memory reference store. */
export const DEFAULT_NAMESPACE = 'default';

export const workflowRuns = sqliteTable(
  'durable_workflow_runs',
  {
    id: text('id').primaryKey(),
    workflow: text('workflow').notNull(),
    workflowVersion: text('workflow_version').notNull(),
    status: text('status').notNull(),
    input: text('input', { mode: 'json' }),
    output: text('output', { mode: 'json' }),
    error: text('error', { mode: 'json' }),
    wakeAt: integer('wake_at'),
    lockedBy: text('locked_by'),
    lockedUntil: integer('locked_until'),
    // REMOTE turn the engine suspended on awaiting a decision; matched by completeRemoteDecision so
    // only the currently-awaited turn's decision is applied. Nullable: cleared when a decision lands.
    awaitingDecisionTaskId: text('awaiting_decision_task_id'),
    recoveryAttempts: integer('recovery_attempts'),
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    searchAttributes: text('search_attributes', { mode: 'json' }).$type<
      Record<string, string | number | boolean>
    >(),
    priority: integer('priority'),
    // The worker-pool partition (tenant) this run belongs to, stamped at creation from the creating
    // engine's `namespace`. THE ISOLATION BOUNDARY, not a dashboard facet: a worker only picks up
    // (`listPendingRuns`), recovers (`listIncompleteRuns`), resumes timers for (`listDueTimers`) and
    // times out (`listRuns({ namespace })`) runs in its own namespace. Direct reads — `getRun`, an
    // unfiltered dashboard listing — are deliberately NOT scoped (see `WorkflowRun.namespace`).
    //
    // NOT NULL DEFAULT 'default', deliberately unlike `origin` below. A run written before this
    // column existed DID execute in a namespace — the unscoped one — so backfilling it to 'default'
    // states a fact rather than inventing one, and it is the only value that keeps such a run
    // reachable: a default-namespace worker asking for 'default' would silently skip a row left
    // NULL, and the run would sit pending forever with nothing in any log to explain it.
    //
    // MIGRATION — this adapter alone has no auto-schema (you own the migrations), and skipping this
    // one breaks EVERY run query, not just namespace-filtered ones, because drizzle SELECTs every
    // column declared here ("no such column: namespace"). The same trap `origin` and `priority` set:
    //
    //     ALTER TABLE durable_workflow_runs ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';
    //     CREATE INDEX IF NOT EXISTS durable_workflow_runs_namespace_status_idx
    //       ON durable_workflow_runs (namespace, status, created_at);
    //
    // SQLite applies the DEFAULT to every existing row as part of ADD COLUMN, so old runs land in
    // 'default' and stay visible to an unscoped worker. Run a bare `ADD COLUMN namespace TEXT`
    // instead and those rows are NULL; the store's namespace predicate reads NULL as 'default' so
    // they are not orphaned, but the NOT NULL form above is the one to run.
    namespace: text('namespace').notNull().default(DEFAULT_NAMESPACE),
    // Which library/module registered the workflow this run belongs to (e.g.
    // `@dudousxd/nestjs-catalog-pipeline`), derived at registration time — never caller input.
    // Nullable with NO default: an origin cannot be reconstructed for a row written before this column
    // existed, so it stays NULL and reads back as `undefined` = "unknown". A real-looking default would
    // be indistinguishable from a genuine registration in the dashboard's facet.
    //
    // MIGRATION (this adapter alone has no auto-schema — you own the migrations): an existing database
    // needs `ALTER TABLE durable_workflow_runs ADD COLUMN origin TEXT;`. Drizzle SELECTs every column
    // declared here, so until that runs, EVERY run query fails with "no such column: origin" — the same
    // step `priority` needed before it.
    origin: text('origin'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    // `namespace` sits on EVERY poll tick's predicate — the pending (FIFO by `created_at`),
    // incomplete and due-timer scans all filter by it and then by `status` — unlike `origin`, which
    // only the dashboard's listing touches. Mirrors the MikroORM adapter's
    // `durable_workflow_runs_namespace_status_idx` (namespace, status, createdAt) so a store swap
    // keeps the same plan. Declaring it here reaches only a database built or migrated from this
    // schema afterwards (`drizzle-kit generate` + `migrate`); an already-deployed one gets nothing
    // until it runs the CREATE INDEX spelled out on the column above.
    index('durable_workflow_runs_namespace_status_idx').on(t.namespace, t.status, t.createdAt),
  ],
);

export const stepCheckpoints = sqliteTable(
  'durable_step_checkpoints',
  {
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    stepId: text('step_id').notNull(),
    status: text('status').notNull(),
    input: text('input', { mode: 'json' }),
    output: text('output', { mode: 'json' }),
    error: text('error', { mode: 'json' }),
    events: text('events', { mode: 'json' }),
    attempts: integer('attempts').notNull(),
    workerGroup: text('worker_group'),
    // A ctx.gather/ctx.all fan tags every sibling step with the same group so the dashboard renders
    // them as one parallel group; the core engine sets it (incl. from a remote worker's recordStep).
    parallelGroup: text('parallel_group'),
    wakeAt: integer('wake_at'),
    enqueuedAt: integer('enqueued_at'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

// Normalized search-attribute side-table: one row per (run, key), so range/equality attribute
// predicates push DOWN into SQL via an EXISTS join instead of a coarse scan + in-process filter.
// Maintained on every createRun/updateRun. Numbers land in `numValue`, strings/booleans in
// `strValue` (booleans as "true"/"false"); see core `normalizeAttributeRows`.
export const runAttributes = sqliteTable(
  'durable_run_attributes',
  {
    runId: text('run_id').notNull(),
    key: text('key').notNull(),
    strValue: text('str_value'),
    numValue: real('num_value'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.key] })],
);

export const signalWaiters = sqliteTable('durable_signal_waiters', {
  token: text('token').primaryKey(),
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  // A ctx.gather_children/ctx.all child fan-out tags every awaited child with the same group; the
  // engine threads it onto the waiter so the resolving `signal:child:` checkpoint carries it and the
  // dashboard renders the fan as one parallel group. Nullable: only fan-out child waiters carry it.
  parallelGroup: text('parallel_group'),
});

export const bufferedSignals = sqliteTable('durable_buffered_signals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  token: text('token').notNull(),
  payload: text('payload', { mode: 'json' }),
});

// A published event that matched no live waiter (see `engine.publishEvent`'s buffering). Keyed by a
// caller-minted `id` (a uuid, not autoincrement — `removeBufferedEvent` targets it directly), not by
// `runId`: events are name-based pub/sub, not tied to any one run.
export const bufferedEvents = sqliteTable('durable_buffered_events', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  payload: text('payload', { mode: 'json' }),
  publishedAt: integer('published_at').notNull(),
});

export const durableSchema = {
  workflowRuns,
  stepCheckpoints,
  runAttributes,
  signalWaiters,
  bufferedSignals,
  bufferedEvents,
};

/**
 * Tables this store creates and manages (you run the migrations — see the package README — but
 * these are the fixed set `durableSchema` declares). Feed to your ORM's migration differ
 * exclude/skipTables so it never tries to drop them.
 *
 * ```ts
 * // MikroORM-flavoured example (Drizzle Kit has no built-in equivalent option); adapt to whichever
 * // migration tool generates your diffs.
 * const skipTables = new Set(durableManagedTables());
 * ```
 *
 * Derived from {@link durableSchema} via drizzle-orm's own `getTableName` — one list, so a
 * consumer's denylist can never drift from the table names declared above.
 */
export function durableManagedTables(): string[] {
  return Object.values(durableSchema).map((table) => getTableName(table));
}
