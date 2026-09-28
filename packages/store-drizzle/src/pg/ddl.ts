import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

/**
 * The durable tables as idempotent Postgres DDL — the exact SQL twin of the `pgTable` definitions in
 * `./schema` (same tables, columns, types, defaults, primary keys and index names; a spec pins the two
 * against each other on a real Postgres, so they cannot drift).
 *
 * Every statement is `IF NOT EXISTS`, so the list is safe to run on every boot
 * ({@link ensureDrizzlePgDurableSchema}, which `DrizzlePgStateStore.ensureSchema()` calls when the
 * module's `autoSchema` is on) or to paste into a hand-written migration:
 *
 * ```ts
 * // drizzle/0007_durable.sql — or a custom migration step
 * import { DURABLE_PG_DDL } from '@dudousxd/nestjs-durable-store-drizzle/pg';
 * console.log(DURABLE_PG_DDL.join(';\n') + ';');
 * ```
 *
 * A column added by a future version is appended here as `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, so
 * an existing database heals on the next boot exactly like the MikroORM / TypeORM auto-schema does.
 */
export const DURABLE_PG_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "durable_workflow_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow" text NOT NULL,
  "workflow_version" text NOT NULL,
  "status" text NOT NULL,
  "input" jsonb,
  "output" jsonb,
  "error" jsonb,
  "wake_at" timestamp with time zone,
  "locked_by" text,
  "locked_until" timestamp with time zone,
  "awaiting_decision_task_id" text,
  "recovery_attempts" integer,
  "tags" jsonb,
  "search_attributes" jsonb,
  "priority" integer,
  "namespace" text DEFAULT 'default' NOT NULL,
  "origin" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS "durable_step_checkpoints" (
  "run_id" text NOT NULL,
  "seq" integer NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "step_id" text NOT NULL,
  "status" text NOT NULL,
  "input" jsonb,
  "output" jsonb,
  "error" jsonb,
  "events" jsonb,
  "attempts" integer NOT NULL,
  "worker_group" text,
  "parallel_group" text,
  "wake_at" timestamp with time zone,
  "enqueued_at" timestamp with time zone,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone NOT NULL,
  CONSTRAINT "durable_step_checkpoints_run_id_seq_pk" PRIMARY KEY("run_id","seq")
)`,
  `CREATE TABLE IF NOT EXISTS "durable_run_attributes" (
  "run_id" text NOT NULL,
  "key" text NOT NULL,
  "str_value" text,
  "num_value" double precision,
  CONSTRAINT "durable_run_attributes_run_id_key_pk" PRIMARY KEY("run_id","key")
)`,
  `CREATE TABLE IF NOT EXISTS "durable_signal_waiters" (
  "token" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "seq" integer NOT NULL,
  "parallel_group" text
)`,
  `CREATE TABLE IF NOT EXISTS "durable_buffered_signals" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "payload" jsonb
)`,
  `CREATE TABLE IF NOT EXISTS "durable_buffered_events" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "payload" jsonb,
  "published_at" timestamp with time zone NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS "durable_schedules" (
  "id" text PRIMARY KEY NOT NULL,
  "namespace" text DEFAULT 'default' NOT NULL,
  "workflow" text NOT NULL,
  "paused" boolean DEFAULT false NOT NULL,
  "next_fire_at" timestamp with time zone,
  "tags" jsonb,
  "spec" jsonb NOT NULL,
  "state" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS "durable_runs_status_idx" ON "durable_workflow_runs" USING btree ("status","wake_at")`,
  `CREATE INDEX IF NOT EXISTS "durable_runs_workflow_status_idx" ON "durable_workflow_runs" USING btree ("workflow","status")`,
  `CREATE INDEX IF NOT EXISTS "durable_workflow_runs_namespace_status_idx" ON "durable_workflow_runs" USING btree ("namespace","status","created_at")`,
  `CREATE INDEX IF NOT EXISTS "durable_runs_tags_gin_idx" ON "durable_workflow_runs" USING gin ("tags" jsonb_path_ops)`,
  `CREATE INDEX IF NOT EXISTS "durable_runs_status_updated_idx" ON "durable_workflow_runs" USING btree ("status","updated_at")`,
  `CREATE INDEX IF NOT EXISTS "durable_run_attributes_num_idx" ON "durable_run_attributes" USING btree ("key","num_value")`,
  `CREATE INDEX IF NOT EXISTS "durable_run_attributes_str_idx" ON "durable_run_attributes" USING btree ("key","str_value")`,
  `CREATE INDEX IF NOT EXISTS "durable_signal_waiters_run_id_idx" ON "durable_signal_waiters" USING btree ("run_id")`,
  `CREATE INDEX IF NOT EXISTS "durable_buffered_signals_token_idx" ON "durable_buffered_signals" USING btree ("token","id")`,
  `CREATE INDEX IF NOT EXISTS "durable_buffered_events_name_published_at_idx" ON "durable_buffered_events" USING btree ("name","published_at")`,
  `CREATE INDEX IF NOT EXISTS "durable_schedules_due_idx" ON "durable_schedules" USING btree ("paused","next_fire_at")`,
];

/** Key for the transaction-scoped advisory lock that serializes concurrent heals (several pods
 *  booting at once would otherwise race `CREATE INDEX IF NOT EXISTS` into a duplicate-key error). */
const SCHEMA_LOCK_KEY = 'durable_schema';

/**
 * Idempotently create the durable tables + indexes on `db` (any drizzle Postgres driver). Runs in one
 * transaction under a `pg_advisory_xact_lock`, so N pods booting together heal the schema once and
 * the rest see it done. Only ever touches the `durable_*` tables.
 */
export async function ensureDrizzlePgDurableSchema(db: PgDatabase<any, any, any>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SCHEMA_LOCK_KEY}))`);
    for (const statement of DURABLE_PG_DDL) await tx.execute(sql.raw(statement));
  });
}
