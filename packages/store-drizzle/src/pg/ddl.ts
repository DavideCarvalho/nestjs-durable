import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { rowsOf } from './executor';

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
  `CREATE INDEX IF NOT EXISTS "durable_step_checkpoints_group_idx" ON "durable_step_checkpoints" USING btree ("run_id","parallel_group","seq")`,
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
 * Where {@link ensureDrizzlePgDurableSchema} reports a schema repair it actually applied. `console`
 * (the default) satisfies it, and so does NestJS's `Logger`, so an app can route the warning into
 * its own log stream.
 */
export interface DurableSchemaLogger {
  warn(message: string): void;
}

export interface EnsureDrizzlePgDurableSchemaOptions {
  /** Sink for the schema-repair warning. Defaults to `console`. */
  logger?: DurableSchemaLogger | undefined;
}

/**
 * The warning logged when the boot-time check changed an EXISTING durable schema: created a table
 * that was missing next to ones that exist, added a column, or created an index. Never logged when
 * the schema was already current, and never on a fresh install (no durable table existed, so
 * creating them all is the expected first boot, not a drift).
 *
 * The discriminator matters more than the wording: a warning on every boot would be filtered as
 * noise, and a silent repair hides a drizzle-kit-managed schema that has drifted from the library.
 */
export function drizzlePgSchemaRepairWarning(repairs: readonly string[]): string {
  return [
    `[nestjs-durable] store-drizzle repaired the durable schema at boot: ${repairs.join('; ')}.`,
    'The database had drifted from the schema this library version expects (it was created by an',
    'older version, or a migration left these out), so they were applied at runtime and nothing',
    'recorded them in your migration history. To make them permanent, generate a drizzle-kit',
    'migration from `durablePgSchema` (or apply `DURABLE_PG_DDL` in a migration). This warning',
    'appears only when a repair was applied; a schema that is already current logs nothing.',
  ].join(' ');
}

/** What a {@link DURABLE_PG_DDL} statement creates, parsed from its text. */
type DdlTarget =
  | { kind: 'table'; table: string }
  | { kind: 'index'; index: string; table: string }
  | { kind: 'column'; table: string; column: string };

function ddlTarget(statement: string): DdlTarget | undefined {
  const table = statement.match(/^CREATE TABLE IF NOT EXISTS "([^"]+)"/i);
  if (table?.[1]) return { kind: 'table', table: table[1] };
  const index = statement.match(
    /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?IF NOT EXISTS "([^"]+)" ON "([^"]+)"/i,
  );
  if (index?.[1] && index[2]) return { kind: 'index', index: index[1], table: index[2] };
  const column = statement.match(/^ALTER TABLE "([^"]+)" ADD COLUMN IF NOT EXISTS "([^"]+)"/i);
  if (column?.[1] && column[2]) return { kind: 'column', table: column[1], column: column[2] };
  return undefined;
}

/**
 * Idempotently create the durable tables + indexes on `db` (any drizzle Postgres driver). Runs in one
 * transaction under a `pg_advisory_xact_lock`, so N pods booting together heal the schema once and
 * the rest see it done. Only ever touches the `durable_*` tables.
 *
 * The DDL is all `IF NOT EXISTS`, which does not say whether it created anything, so the current
 * durable tables, columns and indexes are read from the catalog first (inside the lock) and each
 * statement that will create something is recorded. When anything was created on an EXISTING durable
 * schema, ONE warning listing it goes to `options.logger` (default `console`) after the transaction
 * commits; see {@link drizzlePgSchemaRepairWarning}. A current schema and a fresh install log nothing.
 */
export async function ensureDrizzlePgDurableSchema(
  db: PgDatabase<any, any, any>,
  options: EnsureDrizzlePgDurableSchemaOptions = {},
): Promise<void> {
  const logger = options.logger ?? console;
  const { repairs, freshInstall } = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SCHEMA_LOCK_KEY}))`);
    const tables = new Set(
      rowsOf<{ name: string }>(
        await tx.execute(
          sql.raw(
            "SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND left(tablename, 8) = 'durable_'",
          ),
        ),
      ).map((row) => row.name),
    );
    const indexes = new Set(
      rowsOf<{ name: string }>(
        await tx.execute(
          sql.raw(
            "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND left(tablename, 8) = 'durable_'",
          ),
        ),
      ).map((row) => row.name),
    );
    const columns = new Set(
      rowsOf<{ name: string }>(
        await tx.execute(
          sql.raw(
            "SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND left(table_name, 8) = 'durable_'",
          ),
        ),
      ).map((row) => row.name),
    );

    const created = new Set<string>();
    const ddlTables = new Set<string>();
    const applied: string[] = [];
    for (const statement of DURABLE_PG_DDL) {
      const target = ddlTarget(statement);
      await tx.execute(sql.raw(statement));
      if (!target) continue;
      if (target.kind === 'table') {
        ddlTables.add(target.table);
        if (!tables.has(target.table)) {
          created.add(target.table);
          applied.push(`created table ${target.table}`);
        }
      } else if (created.has(target.table)) {
        // Part of creating that table just now: not a separate repair.
      } else if (target.kind === 'index' && !indexes.has(target.index)) {
        applied.push(`created index ${target.index} on ${target.table}`);
      } else if (target.kind === 'column' && !columns.has(`${target.table}.${target.column}`)) {
        applied.push(`added column ${target.table}.${target.column}`);
      }
    }
    return { repairs: applied, freshInstall: created.size === ddlTables.size };
  });
  if (repairs.length > 0 && !freshInstall) logger.warn(drizzlePgSchemaRepairWarning(repairs));
}
