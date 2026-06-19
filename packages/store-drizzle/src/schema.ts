import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// SQLite / libSQL schema for the durable tables. Timestamps and `wakeAt` are epoch-ms integers
// (SQLite has no native date type). Import these tables and pass them with your drizzle db.

export const workflowRuns = sqliteTable('durable_workflow_runs', {
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
  recoveryAttempts: integer('recovery_attempts'),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
  searchAttributes: text('search_attributes', { mode: 'json' }).$type<
    Record<string, string | number | boolean>
  >(),
  priority: integer('priority'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

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
});

export const bufferedSignals = sqliteTable('durable_buffered_signals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  token: text('token').notNull(),
  payload: text('payload', { mode: 'json' }),
});

export const durableSchema = {
  workflowRuns,
  stepCheckpoints,
  runAttributes,
  signalWaiters,
  bufferedSignals,
};
