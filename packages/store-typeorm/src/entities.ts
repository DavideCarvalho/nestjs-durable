import type { RunStatus, StepKind } from '@dudousxd/nestjs-durable-core';
import {
  Column,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  type ValueTransformer,
} from 'typeorm';

/**
 * Safely deserialize a JSON-text column back to an object on READ.
 *
 * A column truncated by the old MySQL `text` 64KB limit (or otherwise corrupt) makes `JSON.parse`
 * throw "Unterminated string in JSON" — which, without this guard, would 500 the *entire* run-detail
 * read just because one blob is damaged. Instead, log once and degrade the bad field to `undefined`
 * so the rest of the run still renders. Valid JSON is unchanged.
 */
export function parseJsonColumn<T = unknown>(raw: unknown, field: string): T | undefined {
  if (raw == null) return undefined;
  // Some drivers (e.g. a native `json` column) already hand back a parsed object.
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(
      `durable store: failed to parse ${field} column, degrading to undefined: ${
        (err as Error).message
      }`,
    );
    return undefined;
  }
}

/**
 * TypeORM transformer for the free-form JSON-blob columns. Mirrors the built-in `simple-json`
 * serialization on WRITE (`JSON.stringify`, SQL NULL stays NULL) but uses {@link parseJsonColumn}
 * on READ so a single corrupt/truncated row degrades to `undefined` instead of throwing.
 */
function jsonColumnTransformer(field: string): ValueTransformer {
  return {
    to: (value: unknown) => (value == null ? null : JSON.stringify(value)),
    from: (value: unknown) => parseJsonColumn(value, field),
  };
}

@Entity({ name: 'durable_workflow_runs' })
export class WorkflowRunEntity {
  @PrimaryColumn('text')
  id!: string;

  @Column('text')
  workflow!: string;

  @Column('text')
  workflowVersion!: string;

  @Column('text')
  status!: RunStatus;

  @Column('text', { nullable: true, transformer: jsonColumnTransformer('runs.input') })
  input?: unknown;

  @Column('text', { nullable: true, transformer: jsonColumnTransformer('runs.output') })
  output?: unknown;

  @Column('text', { nullable: true, transformer: jsonColumnTransformer('runs.error') })
  error?: unknown;

  @Column({ nullable: true })
  wakeAt?: Date;

  @Column('text', { nullable: true })
  lockedBy?: string | null;

  @Column({ nullable: true })
  lockedUntil?: Date;

  @Column('integer', { nullable: true })
  recoveryAttempts?: number;

  @Column('text', { nullable: true, transformer: jsonColumnTransformer('runs.tags') })
  tags?: string[] | null;

  @Column('text', {
    nullable: true,
    transformer: jsonColumnTransformer('runs.searchAttributes'),
  })
  searchAttributes?: Record<string, string | number | boolean> | null;

  @Column()
  createdAt!: Date;

  @Column()
  updatedAt!: Date;
}

@Entity({ name: 'durable_step_checkpoints' })
export class StepCheckpointEntity {
  @PrimaryColumn('text')
  runId!: string;

  @PrimaryColumn('integer')
  seq!: number;

  @Column('text')
  name!: string;

  @Column('text')
  kind!: StepKind;

  @Column('text')
  stepId!: string;

  @Column('text')
  status!: 'pending' | 'running' | 'completed' | 'failed';

  @Column('text', { nullable: true, transformer: jsonColumnTransformer('checkpoints.input') })
  input?: unknown;

  @Column('text', { nullable: true, transformer: jsonColumnTransformer('checkpoints.output') })
  output?: unknown;

  @Column('text', { nullable: true, transformer: jsonColumnTransformer('checkpoints.error') })
  error?: unknown;

  @Column('text', { nullable: true, transformer: jsonColumnTransformer('checkpoints.events') })
  events?: unknown;

  @Column('integer')
  attempts!: number;

  @Column('text', { nullable: true })
  workerGroup?: string | null;

  @Column({ nullable: true })
  wakeAt?: Date;

  @Column({ nullable: true })
  enqueuedAt?: Date;

  @Column()
  startedAt!: Date;

  @Column()
  finishedAt!: Date;
}

/**
 * Normalized side-table for search attributes: one row per (run, key), so range/equality predicates
 * push DOWN into SQL (an EXISTS join indexed on `(key, numValue)` / `(key, strValue)`) instead of a
 * coarse scan + in-process filter. Maintained on every `createRun`/`updateRun`. Numbers land in
 * `numValue`, strings/booleans in `strValue` (booleans as `"true"`/`"false"`); see `normalizeAttributeRows`.
 */
@Entity({ name: 'durable_run_attributes' })
export class RunAttributeEntity {
  @PrimaryColumn('text')
  runId!: string;

  @PrimaryColumn('text')
  key!: string;

  @Column('text', { nullable: true })
  strValue?: string | null;

  // `float`/`double` portable across SQLite/MySQL/Postgres for numeric range scans.
  @Column('float', { nullable: true })
  numValue?: number | null;
}

@Entity({ name: 'durable_signal_waiters' })
export class SignalWaiterEntity {
  @PrimaryColumn('text')
  token!: string;

  @Column('text')
  runId!: string;

  @Column('integer')
  seq!: number;
}

@Entity({ name: 'durable_buffered_signals' })
export class BufferedSignalEntity {
  // Auto-increment PK for FIFO ordering. Left as TypeORM's default increment type so it maps to the
  // driver-native auto-increment column (INTEGER on SQLite, BIGINT/SERIAL on MySQL/Postgres).
  @PrimaryGeneratedColumn()
  id!: number;

  @Column('text')
  token!: string;

  @Column('text', { nullable: true, transformer: jsonColumnTransformer('buffered.payload') })
  payload?: unknown;
}

export const ENTITIES = [
  WorkflowRunEntity,
  StepCheckpointEntity,
  RunAttributeEntity,
  SignalWaiterEntity,
  BufferedSignalEntity,
] as const;
