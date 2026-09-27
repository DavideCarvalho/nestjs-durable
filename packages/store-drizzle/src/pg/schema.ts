import { getTableName } from 'drizzle-orm';
import {
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// PostgreSQL schema for the durable tables. Physical table + column names are the canonical
// cross-adapter ones (`DURABLE_CANONICAL_COLUMNS` in -testing) — the same ones the SQLite schema in
// `../schema`, the MikroORM, TypeORM and Prisma adapters use. The Postgres-native choices:
//  - timestamps / `wake_at` / `locked_until` are `timestamptz` (like the TypeORM + MikroORM PG DDL),
//  - JSON payloads are `jsonb` (like MikroORM's PG mapping) — which is what lets `tags` be matched
//    with the GIN-indexable `@>` containment operator instead of a leading-wildcard LIKE,
//  - every string is `text` (Postgres has no `varchar(n)` speed advantage, and a signal/event token
//    can be longer than the `varchar(191)` MySQL forces on the TypeORM DDL).
//
// Spread `durablePgSchema` (or re-export the individual tables) from the schema file your
// `drizzle.config.ts` points at, and drizzle-kit generates the migration for you. Or skip drizzle-kit
// for these tables and let `DrizzlePgStateStore.ensureSchema()` create them — `./ddl` is the same DDL
// as SQL, and a spec pins the two against each other so they can never drift.

/** The namespace a run belongs to when its creating engine named none (column DEFAULT below). */
export const DEFAULT_NAMESPACE = 'default';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const durableWorkflowRuns = pgTable(
  'durable_workflow_runs',
  {
    id: text('id').primaryKey(),
    workflow: text('workflow').notNull(),
    workflowVersion: text('workflow_version').notNull(),
    status: text('status').notNull(),
    input: jsonb('input'),
    output: jsonb('output'),
    error: jsonb('error'),
    wakeAt: tstz('wake_at'),
    lockedBy: text('locked_by'),
    lockedUntil: tstz('locked_until'),
    // REMOTE turn the engine suspended on awaiting a decision; matched by completeRemoteDecision so
    // only the currently-awaited turn's decision is applied. Nullable: cleared when a decision lands.
    awaitingDecisionTaskId: text('awaiting_decision_task_id'),
    recoveryAttempts: integer('recovery_attempts'),
    tags: jsonb('tags').$type<string[]>(),
    searchAttributes: jsonb('search_attributes').$type<Record<string, string | number | boolean>>(),
    priority: integer('priority'),
    // The worker-pool partition (tenant) — THE isolation boundary every poll predicate filters on.
    // NOT NULL DEFAULT 'default' so a row can never fall outside every worker's namespace.
    namespace: text('namespace').notNull().default(DEFAULT_NAMESPACE),
    // Which package declared the workflow. Nullable, no default: NULL = unknown, never guessed.
    origin: text('origin'),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    // Timer poller (`listDueTimers`) + recovery (`listIncompleteRuns`). Same name as the TypeORM DDL.
    index('durable_runs_status_idx').on(t.status, t.wakeAt),
    // Dashboard `listRuns({ workflow, status })` and the singleton gate's per-workflow scans.
    index('durable_runs_workflow_status_idx').on(t.workflow, t.status),
    // Every namespaced poll tick: `namespace = $1 AND status = $2 ORDER BY created_at` (FIFO pick-up).
    // Name matches the MikroORM adapter + the SQLite drizzle schema so a store swap keeps the index.
    index('durable_workflow_runs_namespace_status_idx').on(t.namespace, t.status, t.createdAt),
    // `listRuns({ tag })` compiles to `tags @> '["tag"]'`, which a `jsonb_path_ops` GIN index serves —
    // this is what keeps the singleton gate (`tag: singleton:<key>`, e.g. a per-tenant concurrency
    // key) an index probe instead of a scan of every run the workflow ever had.
    index('durable_runs_tags_gin_idx').using('gin', t.tags.op('jsonb_path_ops')),
    // Retention (`pruneTerminalRuns`) orders a status set by `updated_at`.
    index('durable_runs_status_updated_idx').on(t.status, t.updatedAt),
  ],
);

export const durableStepCheckpoints = pgTable(
  'durable_step_checkpoints',
  {
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    stepId: text('step_id').notNull(),
    status: text('status').notNull(),
    input: jsonb('input'),
    output: jsonb('output'),
    error: jsonb('error'),
    events: jsonb('events'),
    attempts: integer('attempts').notNull(),
    workerGroup: text('worker_group'),
    parallelGroup: text('parallel_group'),
    wakeAt: tstz('wake_at'),
    enqueuedAt: tstz('enqueued_at'),
    startedAt: tstz('started_at').notNull(),
    finishedAt: tstz('finished_at').notNull(),
  },
  // (run_id, seq) is the primary key, so listCheckpoints / getEvent already hit an index.
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

// Normalized search-attribute side-table: one row per (run, key), so attribute predicates push DOWN
// into SQL as an EXISTS probe on the (key, value) indexes below instead of scan + in-process filter.
export const durableRunAttributes = pgTable(
  'durable_run_attributes',
  {
    runId: text('run_id').notNull(),
    key: text('key').notNull(),
    strValue: text('str_value'),
    numValue: doublePrecision('num_value'),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.key] }),
    index('durable_run_attributes_num_idx').on(t.key, t.numValue),
    index('durable_run_attributes_str_idx').on(t.key, t.strValue),
  ],
);

export const durableSignalWaiters = pgTable(
  'durable_signal_waiters',
  {
    token: text('token').primaryKey(),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    parallelGroup: text('parallel_group'),
  },
  // deleteRun / pruneTerminalRuns delete a run's waiters by run_id.
  (t) => [index('durable_signal_waiters_run_id_idx').on(t.runId)],
);

export const durableBufferedSignals = pgTable(
  'durable_buffered_signals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    token: text('token').notNull(),
    payload: jsonb('payload'),
  },
  // Taken FIFO per token (smallest id first).
  (t) => [index('durable_buffered_signals_token_idx').on(t.token, t.id)],
);

// A published event that matched no live waiter. Keyed by a caller-minted id (engine.publishEvent)
// so removeBufferedEvent can target that exact row.
export const durableBufferedEvents = pgTable(
  'durable_buffered_events',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    payload: jsonb('payload'),
    publishedAt: tstz('published_at').notNull(),
  },
  (t) => [index('durable_buffered_events_name_published_at_idx').on(t.name, t.publishedAt)],
);

/**
 * Every durable table, keyed by the name to export it under. Spread into your drizzle-kit schema file
 * (`export const { durableWorkflowRuns, ... } = durablePgSchema;` or `export * from` the `/pg` entry)
 * so `drizzle-kit generate` emits the durable DDL alongside your own tables.
 */
export const durablePgSchema = {
  durableWorkflowRuns,
  durableStepCheckpoints,
  durableRunAttributes,
  durableSignalWaiters,
  durableBufferedSignals,
  durableBufferedEvents,
};

/**
 * The durable table names, derived from {@link durablePgSchema} (one list, never drifts). Feed to a
 * migration tool's exclude list — e.g. drizzle-kit `tablesFilter: ['!durable_*']` — if you let
 * `ensureSchema()` own these tables instead of drizzle-kit.
 */
export function durablePgManagedTables(): string[] {
  return Object.values(durablePgSchema).map((table) => getTableName(table));
}
