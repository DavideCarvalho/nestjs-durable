import type { RunStatus, StepKind } from '@dudousxd/nestjs-durable-core';
import { EntitySchema, type ValueTransformer } from 'typeorm';

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

/**
 * How property names map to physical column names. The durable tables are adapter-agnostic: a run
 * written by one store adapter must be readable by another, so every adapter has to agree on the
 * physical column names. The default is `'snake_case'` (the canonical, matched by the MikroORM,
 * Prisma and Drizzle adapters). `'preserve'` keeps the camelCase property name verbatim (what the
 * old TypeORM/Prisma adapters produced before they were pinned). A function lets you supply any
 * custom mapping.
 *
 * The choice is pinned EXPLICITLY onto the entity schema rather than left to the host ORM's naming
 * strategy — depending on the host strategy is what silently diverged the adapters and broke a store
 * swap against an existing table.
 */
export type DurableColumnNaming = 'snake_case' | 'preserve' | ((property: string) => string);

function snakeCase(property: string): string {
  return property.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Resolve a `DurableColumnNaming` to a `(property) => columnName` function. */
export function columnNamer(naming: DurableColumnNaming): (property: string) => string {
  if (naming === 'snake_case') return snakeCase;
  if (naming === 'preserve') return (property) => property;
  return naming;
}

// Plain classes (no decorators): the schema/column mapping lives on the EntitySchema built by
// `durableEntities`, so the same class can be registered under different column names. The store
// still references these classes for `getRepository`/`getMetadata`.

export class WorkflowRunEntity {
  id!: string;
  workflow!: string;
  workflowVersion!: string;
  status!: RunStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  wakeAt?: Date;
  lockedBy?: string | null;
  lockedUntil?: Date;
  awaitingDecisionTaskId?: string | null;
  recoveryAttempts?: number;
  tags?: string[] | null;
  searchAttributes?: Record<string, string | number | boolean> | null;
  priority?: number | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export class StepCheckpointEntity {
  runId!: string;
  seq!: number;
  name!: string;
  kind!: StepKind;
  stepId!: string;
  status!: 'pending' | 'running' | 'completed' | 'failed';
  input?: unknown;
  output?: unknown;
  error?: unknown;
  events?: unknown;
  attempts!: number;
  workerGroup?: string | null;
  parallelGroup?: string | null;
  wakeAt?: Date;
  enqueuedAt?: Date;
  startedAt!: Date;
  finishedAt!: Date;
}

/**
 * Normalized side-table for search attributes: one row per (run, key), so range/equality predicates
 * push DOWN into SQL (an EXISTS join indexed on `(key, numValue)` / `(key, strValue)`) instead of a
 * coarse scan + in-process filter. Maintained on every `createRun`/`updateRun`. Numbers land in
 * `numValue`, strings/booleans in `strValue` (booleans as `"true"`/`"false"`); see `normalizeAttributeRows`.
 */
export class RunAttributeEntity {
  runId!: string;
  key!: string;
  strValue?: string | null;
  numValue?: number | null;
}

export class SignalWaiterEntity {
  token!: string;
  runId!: string;
  seq!: number;
  parallelGroup?: string | null;
}

export class BufferedSignalEntity {
  id!: number;
  token!: string;
  payload?: unknown;
}

/**
 * Build the durable TypeORM entity schemas with column names pinned per `naming` (default
 * `'snake_case'`). Register the result in your `DataSource`/`TypeOrmModule.forFeature`. The JSON-blob
 * columns keep the `jsonColumnTransformer` (corruption-tolerant read), the primary keys / auto-
 * increment / nullability are preserved, and the `id` of `durable_buffered_signals` stays a driver-
 * native auto-increment column.
 *
 * ```ts
 * entities: durableEntities({ naming: 'snake_case' })
 * ```
 */
export function durableEntities(options: { naming?: DurableColumnNaming } = {}): EntitySchema[] {
  const col = columnNamer(options.naming ?? 'snake_case');

  const workflowRuns = new EntitySchema<WorkflowRunEntity>({
    name: 'WorkflowRunEntity',
    target: WorkflowRunEntity,
    tableName: 'durable_workflow_runs',
    columns: {
      id: { type: 'text', primary: true, name: col('id') },
      workflow: { type: 'text', name: col('workflow') },
      workflowVersion: { type: 'text', name: col('workflowVersion') },
      status: { type: 'text', name: col('status') },
      input: {
        type: 'text',
        nullable: true,
        name: col('input'),
        transformer: jsonColumnTransformer('runs.input'),
      },
      output: {
        type: 'text',
        nullable: true,
        name: col('output'),
        transformer: jsonColumnTransformer('runs.output'),
      },
      error: {
        type: 'text',
        nullable: true,
        name: col('error'),
        transformer: jsonColumnTransformer('runs.error'),
      },
      wakeAt: { type: Date, nullable: true, name: col('wakeAt') },
      lockedBy: { type: 'text', nullable: true, name: col('lockedBy') },
      lockedUntil: { type: Date, nullable: true, name: col('lockedUntil') },
      // REMOTE turn the engine suspended on awaiting a decision; matched by completeRemoteDecision so
      // only the currently-awaited turn's decision is applied. Nullable: cleared when a decision lands.
      awaitingDecisionTaskId: {
        type: 'text',
        nullable: true,
        name: col('awaitingDecisionTaskId'),
      },
      recoveryAttempts: { type: 'integer', nullable: true, name: col('recoveryAttempts') },
      tags: {
        type: 'text',
        nullable: true,
        name: col('tags'),
        transformer: jsonColumnTransformer('runs.tags'),
      },
      searchAttributes: {
        type: 'text',
        nullable: true,
        name: col('searchAttributes'),
        transformer: jsonColumnTransformer('runs.searchAttributes'),
      },
      priority: { type: 'integer', nullable: true, name: col('priority') },
      createdAt: { type: Date, name: col('createdAt') },
      updatedAt: { type: Date, name: col('updatedAt') },
    },
  });

  const stepCheckpoints = new EntitySchema<StepCheckpointEntity>({
    name: 'StepCheckpointEntity',
    target: StepCheckpointEntity,
    tableName: 'durable_step_checkpoints',
    columns: {
      runId: { type: 'text', primary: true, name: col('runId') },
      seq: { type: 'integer', primary: true, name: col('seq') },
      name: { type: 'text', name: col('name') },
      kind: { type: 'text', name: col('kind') },
      stepId: { type: 'text', name: col('stepId') },
      status: { type: 'text', name: col('status') },
      input: {
        type: 'text',
        nullable: true,
        name: col('input'),
        transformer: jsonColumnTransformer('checkpoints.input'),
      },
      output: {
        type: 'text',
        nullable: true,
        name: col('output'),
        transformer: jsonColumnTransformer('checkpoints.output'),
      },
      error: {
        type: 'text',
        nullable: true,
        name: col('error'),
        transformer: jsonColumnTransformer('checkpoints.error'),
      },
      events: {
        type: 'text',
        nullable: true,
        name: col('events'),
        transformer: jsonColumnTransformer('checkpoints.events'),
      },
      attempts: { type: 'integer', name: col('attempts') },
      workerGroup: { type: 'text', nullable: true, name: col('workerGroup') },
      // A ctx.gather/ctx.all fan tags every sibling step with the same group so the dashboard renders
      // them as one parallel group; the core engine sets it (incl. from a remote worker's recordStep).
      parallelGroup: { type: 'text', nullable: true, name: col('parallelGroup') },
      wakeAt: { type: Date, nullable: true, name: col('wakeAt') },
      enqueuedAt: { type: Date, nullable: true, name: col('enqueuedAt') },
      startedAt: { type: Date, name: col('startedAt') },
      finishedAt: { type: Date, name: col('finishedAt') },
    },
  });

  const runAttributes = new EntitySchema<RunAttributeEntity>({
    name: 'RunAttributeEntity',
    target: RunAttributeEntity,
    tableName: 'durable_run_attributes',
    columns: {
      runId: { type: 'text', primary: true, name: col('runId') },
      key: { type: 'text', primary: true, name: col('key') },
      strValue: { type: 'text', nullable: true, name: col('strValue') },
      // `float`/`double` portable across SQLite/MySQL/Postgres for numeric range scans.
      numValue: { type: 'float', nullable: true, name: col('numValue') },
    },
  });

  const signalWaiters = new EntitySchema<SignalWaiterEntity>({
    name: 'SignalWaiterEntity',
    target: SignalWaiterEntity,
    tableName: 'durable_signal_waiters',
    columns: {
      token: { type: 'text', primary: true, name: col('token') },
      runId: { type: 'text', name: col('runId') },
      seq: { type: 'integer', name: col('seq') },
      // A ctx.gather_children/ctx.all child fan-out tags every awaited child with the same group; the
      // engine threads it onto the waiter so the resolving `signal:child:` checkpoint carries it and the
      // dashboard renders the fan as one parallel group. Nullable: only fan-out child waiters carry it.
      parallelGroup: { type: 'text', nullable: true, name: col('parallelGroup') },
    },
  });

  const bufferedSignals = new EntitySchema<BufferedSignalEntity>({
    name: 'BufferedSignalEntity',
    target: BufferedSignalEntity,
    tableName: 'durable_buffered_signals',
    columns: {
      // Auto-increment PK for FIFO ordering. Left as TypeORM's default increment generation so it
      // maps to the driver-native auto-increment column (INTEGER on SQLite, BIGINT/SERIAL elsewhere).
      id: { type: Number, primary: true, generated: 'increment', name: col('id') },
      token: { type: 'text', name: col('token') },
      payload: {
        type: 'text',
        nullable: true,
        name: col('payload'),
        transformer: jsonColumnTransformer('buffered.payload'),
      },
    },
  });

  return [workflowRuns, stepCheckpoints, runAttributes, signalWaiters, bufferedSignals];
}

/** Durable entity schemas with the canonical `'snake_case'` column names. */
export const ENTITIES = durableEntities();
