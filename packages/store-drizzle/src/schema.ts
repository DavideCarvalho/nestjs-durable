import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

export const signalWaiters = sqliteTable('durable_signal_waiters', {
  token: text('token').primaryKey(),
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
});

export const durableSchema = { workflowRuns, stepCheckpoints, signalWaiters };
