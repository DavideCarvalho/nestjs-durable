import type { RunStatus, StepKind } from '@dudousxd/nestjs-durable-core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'durable_workflow_runs' })
export class WorkflowRunEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ type: 'string' })
  workflow!: string;

  @Property({ type: 'string' })
  workflowVersion!: string;

  @Property({ type: 'string' })
  status!: RunStatus;

  @Property({ type: 'json', nullable: true })
  input?: unknown;

  @Property({ type: 'json', nullable: true })
  output?: unknown;

  @Property({ type: 'json', nullable: true })
  error?: unknown;

  @Property({ type: 'Date', nullable: true })
  wakeAt?: Date;

  @Property({ type: 'string', nullable: true })
  lockedBy?: string;

  @Property({ type: 'Date', nullable: true })
  lockedUntil?: Date;

  @Property({ type: 'integer', nullable: true })
  recoveryAttempts?: number;

  @Property({ type: 'json', nullable: true })
  tags?: string[] | null;

  @Property({ type: 'json', nullable: true })
  searchAttributes?: Record<string, string | number | boolean> | null;

  @Property({ type: 'Date' })
  createdAt!: Date;

  @Property({ type: 'Date' })
  updatedAt!: Date;
}

@Entity({ tableName: 'durable_step_checkpoints' })
export class StepCheckpointEntity {
  @PrimaryKey({ type: 'string' })
  runId!: string;

  @PrimaryKey({ type: 'integer' })
  seq!: number;

  @Property({ type: 'string' })
  name!: string;

  @Property({ type: 'string' })
  kind!: StepKind;

  @Property({ type: 'string' })
  stepId!: string;

  @Property({ type: 'string' })
  status!: 'pending' | 'running' | 'completed' | 'failed';

  @Property({ type: 'json', nullable: true })
  input?: unknown;

  @Property({ type: 'json', nullable: true })
  output?: unknown;

  @Property({ type: 'json', nullable: true })
  error?: unknown;

  @Property({ type: 'json', nullable: true })
  events?: unknown;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property({ type: 'string', nullable: true })
  workerGroup?: string;

  @Property({ type: 'Date', nullable: true })
  wakeAt?: Date;

  @Property({ type: 'Date', nullable: true })
  enqueuedAt?: Date;

  @Property({ type: 'Date' })
  startedAt!: Date;

  @Property({ type: 'Date' })
  finishedAt!: Date;
}

/**
 * Normalized side-table for search attributes: one row per (run, key), so range/equality predicates
 * push DOWN into SQL (an EXISTS join indexed on `(key, numValue)` / `(key, strValue)`) instead of a
 * coarse scan + in-process filter. Maintained on every createRun/updateRun. Numbers land in
 * `numValue`, strings/booleans in `strValue` (booleans as "true"/"false"); see normalizeAttributeRows.
 */
@Entity({ tableName: 'durable_run_attributes' })
export class RunAttributeEntity {
  @PrimaryKey({ type: 'string' })
  runId!: string;

  @PrimaryKey({ type: 'string' })
  key!: string;

  @Property({ type: 'string', nullable: true })
  strValue?: string | null;

  // `float`/`double` is portable across SQLite/MySQL/Postgres for numeric range scans.
  @Property({ type: 'float', nullable: true })
  numValue?: number | null;
}

@Entity({ tableName: 'durable_signal_waiters' })
export class SignalWaiterEntity {
  @PrimaryKey({ type: 'string' })
  token!: string;

  @Property({ type: 'string' })
  runId!: string;

  @Property({ type: 'integer' })
  seq!: number;
}

@Entity({ tableName: 'durable_buffered_signals' })
export class BufferedSignalEntity {
  @PrimaryKey({ autoincrement: true, type: 'integer' })
  id!: number;

  @Property({ index: true, type: 'string' })
  token!: string;

  @Property({ type: 'json', nullable: true })
  payload?: unknown;
}

export const ENTITIES = [
  WorkflowRunEntity,
  StepCheckpointEntity,
  RunAttributeEntity,
  SignalWaiterEntity,
  BufferedSignalEntity,
] as const;
