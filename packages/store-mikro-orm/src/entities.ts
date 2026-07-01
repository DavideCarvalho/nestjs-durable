import type { RunStatus, StepKind } from '@dudousxd/nestjs-durable-core';
import { EntitySchema } from '@mikro-orm/core';

/**
 * How property names map to physical column names. The durable tables are adapter-agnostic: a run
 * written by one store adapter must be readable by another, so every adapter has to agree on the
 * physical column names. The default is `'snake_case'` (the canonical, matched by the TypeORM,
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

function columnNamer(naming: DurableColumnNaming): (property: string) => string {
  if (naming === 'snake_case') return snakeCase;
  if (naming === 'preserve') return (property) => property;
  return naming;
}

// Plain classes (no decorators): the schema/column mapping lives on the EntitySchema built by
// `durableEntities`, so the same class can be registered under different column names. The store
// still references these classes for `em.create`/`getMetadata`.

export class WorkflowRunEntity {
  id!: string;
  workflow!: string;
  workflowVersion!: string;
  status!: RunStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  wakeAt?: Date;
  lockedBy?: string;
  lockedUntil?: Date;
  awaitingDecisionTaskId?: string;
  recoveryAttempts?: number;
  tags?: string[] | null;
  searchAttributes?: Record<string, string | number | boolean> | null;
  priority?: number | null;
  namespace!: string;
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
  workerGroup?: string;
  parallelGroup?: string;
  wakeAt?: Date;
  enqueuedAt?: Date;
  startedAt!: Date;
  finishedAt!: Date;
}

/**
 * Normalized side-table for search attributes: one row per (run, key), so range/equality predicates
 * push DOWN into SQL (an EXISTS join indexed on `(key, numValue)` / `(key, strValue)`) instead of a
 * coarse scan + in-process filter. Maintained on every createRun/updateRun. Numbers land in
 * `numValue`, strings/booleans in `strValue` (booleans as "true"/"false"); see normalizeAttributeRows.
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
 * Build the durable MikroORM entity schemas with column names pinned per `naming` (default
 * `'snake_case'`). Register the result in your MikroORM config / `MikroOrmModule.forFeature`.
 *
 * ```ts
 * entities: durableEntities({ naming: 'snake_case' })
 * ```
 */
/**
 * MikroORM global filter condition for the `namespace` read boundary. Returns `{}` (no restriction)
 * when `namespace` is undefined — the operator (control plane) sees all tenants. Returns a
 * `{ namespace }` equality predicate otherwise, confining the query to that tenant's rows.
 */
function namespaceFilterCond(args: { namespace?: string }): { namespace?: string } {
  if (args.namespace === undefined) return {};
  return { namespace: args.namespace };
}

export function durableEntities(options: { naming?: DurableColumnNaming } = {}): EntitySchema[] {
  const col = columnNamer(options.naming ?? 'snake_case');

  const workflowRuns = new EntitySchema<WorkflowRunEntity>({
    class: WorkflowRunEntity,
    tableName: 'durable_workflow_runs',
    // Global filter: confines every read to the tenant's namespace when the store is scoped.
    // The `cond` returns `{}` (no-op) when the `namespace` arg is `undefined`, so an unscoped
    // (operator / control-plane) store sees all rows unchanged — existing behaviour is preserved.
    filters: {
      namespace: {
        name: 'namespace',
        cond: namespaceFilterCond,
        default: true,
      },
    },
    // Indexes mirror the Prisma adapter so a store swap keeps the same plan. The poller hits these
    // every tick: `(status, wakeAt)` serves both the due-timer scan (status='suspended' AND wakeAt<=now)
    // and, via its `status` prefix, the pending/incomplete status lookups; `(workflow, status)` serves
    // the per-workflow timeout sweep. Without them every poll is a full scan of a table that only grows.
    indexes: [
      { name: 'durable_workflow_runs_status_wake_at_idx', properties: ['status', 'wakeAt'] },
      { name: 'durable_workflow_runs_workflow_status_idx', properties: ['workflow', 'status'] },
      {
        name: 'durable_workflow_runs_namespace_status_idx',
        properties: ['namespace', 'status', 'createdAt'],
      },
    ],
    properties: {
      id: { type: 'string', primary: true, fieldName: col('id') },
      workflow: { type: 'string', fieldName: col('workflow') },
      workflowVersion: { type: 'string', fieldName: col('workflowVersion') },
      status: { type: 'string', fieldName: col('status') },
      input: { type: 'json', nullable: true, fieldName: col('input') },
      output: { type: 'json', nullable: true, fieldName: col('output') },
      error: { type: 'json', nullable: true, fieldName: col('error') },
      wakeAt: { type: 'Date', nullable: true, fieldName: col('wakeAt') },
      lockedBy: { type: 'string', nullable: true, fieldName: col('lockedBy') },
      lockedUntil: { type: 'Date', nullable: true, fieldName: col('lockedUntil') },
      // REMOTE turn the engine suspended on awaiting a decision; matched by completeRemoteDecision so
      // only the currently-awaited turn's decision is applied. Nullable: cleared when a decision lands.
      awaitingDecisionTaskId: {
        type: 'string',
        nullable: true,
        fieldName: col('awaitingDecisionTaskId'),
      },
      recoveryAttempts: { type: 'integer', nullable: true, fieldName: col('recoveryAttempts') },
      tags: { type: 'json', nullable: true, fieldName: col('tags') },
      searchAttributes: { type: 'json', nullable: true, fieldName: col('searchAttributes') },
      priority: { type: 'integer', nullable: true, fieldName: col('priority') },
      namespace: { type: 'string', default: 'default', fieldName: col('namespace') },
      createdAt: { type: 'Date', fieldName: col('createdAt') },
      updatedAt: { type: 'Date', fieldName: col('updatedAt') },
    },
  });

  const stepCheckpoints = new EntitySchema<StepCheckpointEntity>({
    class: StepCheckpointEntity,
    tableName: 'durable_step_checkpoints',
    properties: {
      runId: { type: 'string', primary: true, fieldName: col('runId') },
      seq: { type: 'integer', primary: true, fieldName: col('seq') },
      name: { type: 'string', fieldName: col('name') },
      kind: { type: 'string', fieldName: col('kind') },
      stepId: { type: 'string', fieldName: col('stepId') },
      status: { type: 'string', fieldName: col('status') },
      input: { type: 'json', nullable: true, fieldName: col('input') },
      output: { type: 'json', nullable: true, fieldName: col('output') },
      error: { type: 'json', nullable: true, fieldName: col('error') },
      events: { type: 'json', nullable: true, fieldName: col('events') },
      attempts: { type: 'integer', fieldName: col('attempts') },
      workerGroup: { type: 'string', nullable: true, fieldName: col('workerGroup') },
      // A ctx.gather/ctx.all fan tags every sibling step with the same group string so the dashboard
      // renders them as one "ran in parallel" group. The core engine sets it (incl. from a remote
      // worker's recordStep), but it was never persisted here — so the fan always rendered as N
      // sequential singles. Nullable: only fan-out steps carry it.
      parallelGroup: { type: 'string', nullable: true, fieldName: col('parallelGroup') },
      wakeAt: { type: 'Date', nullable: true, fieldName: col('wakeAt') },
      enqueuedAt: { type: 'Date', nullable: true, fieldName: col('enqueuedAt') },
      startedAt: { type: 'Date', fieldName: col('startedAt') },
      finishedAt: { type: 'Date', fieldName: col('finishedAt') },
    },
  });

  const runAttributes = new EntitySchema<RunAttributeEntity>({
    class: RunAttributeEntity,
    tableName: 'durable_run_attributes',
    // The search-attribute EXISTS join (see the class docstring) pushes equality/range predicates down
    // onto `(key, numValue)` / `(key, strValue)`; mirror the Prisma adapter so those scans stay indexed.
    indexes: [
      { name: 'durable_run_attributes_key_num_idx', properties: ['key', 'numValue'] },
      { name: 'durable_run_attributes_key_str_idx', properties: ['key', 'strValue'] },
    ],
    properties: {
      runId: { type: 'string', primary: true, fieldName: col('runId') },
      key: { type: 'string', primary: true, fieldName: col('key') },
      strValue: { type: 'string', nullable: true, fieldName: col('strValue') },
      // `float`/`double` is portable across SQLite/MySQL/Postgres for numeric range scans.
      numValue: { type: 'float', nullable: true, fieldName: col('numValue') },
    },
  });

  const signalWaiters = new EntitySchema<SignalWaiterEntity>({
    class: SignalWaiterEntity,
    tableName: 'durable_signal_waiters',
    properties: {
      token: { type: 'string', primary: true, fieldName: col('token') },
      runId: { type: 'string', fieldName: col('runId') },
      seq: { type: 'integer', fieldName: col('seq') },
      // A ctx.gather_children/ctx.all child fan-out tags every awaited child with the same group; the
      // engine threads it onto the waiter so the resolving `signal:child:` checkpoint carries it and the
      // dashboard renders the fan as one parallel group. Nullable: only fan-out child waiters carry it.
      parallelGroup: { type: 'string', nullable: true, fieldName: col('parallelGroup') },
    },
  });

  const bufferedSignals = new EntitySchema<BufferedSignalEntity>({
    class: BufferedSignalEntity,
    tableName: 'durable_buffered_signals',
    properties: {
      id: { type: 'integer', primary: true, autoincrement: true, fieldName: col('id') },
      token: { type: 'string', index: true, fieldName: col('token') },
      payload: { type: 'json', nullable: true, fieldName: col('payload') },
    },
  });

  return [workflowRuns, stepCheckpoints, runAttributes, signalWaiters, bufferedSignals];
}

/** Durable entity schemas with the canonical `'snake_case'` column names. */
export const ENTITIES = durableEntities();
