/**
 * The tenancy columns (`tenant_id`, `tenant_kind`) are read by every run and schedule query, even
 * with tenancy off. A database migrated before they existed fails those queries with a bare
 * "column does not exist" error; this turns it into one that names the migration to run.
 */

const PG_STATEMENTS = [
  'ALTER TABLE "durable_workflow_runs" ADD COLUMN IF NOT EXISTS "tenant_id" text;',
  'ALTER TABLE "durable_workflow_runs" ADD COLUMN IF NOT EXISTS "tenant_kind" text;',
  'ALTER TABLE "durable_schedules" ADD COLUMN IF NOT EXISTS "tenant_id" text;',
  'ALTER TABLE "durable_schedules" ADD COLUMN IF NOT EXISTS "tenant_kind" text;',
  'CREATE INDEX IF NOT EXISTS "durable_workflow_runs_tenant_idx" ON "durable_workflow_runs" USING btree ("tenant_id","created_at");',
  'CREATE INDEX IF NOT EXISTS "durable_schedules_tenant_idx" ON "durable_schedules" USING btree ("tenant_id");',
];

const SQLITE_STATEMENTS = [
  'ALTER TABLE durable_workflow_runs ADD COLUMN tenant_id TEXT;',
  'ALTER TABLE durable_workflow_runs ADD COLUMN tenant_kind TEXT;',
  'ALTER TABLE durable_schedules ADD COLUMN tenant_id TEXT;',
  'ALTER TABLE durable_schedules ADD COLUMN tenant_kind TEXT;',
  'CREATE INDEX IF NOT EXISTS durable_workflow_runs_tenant_idx ON durable_workflow_runs (tenant_id, created_at);',
  'CREATE INDEX IF NOT EXISTS durable_schedules_tenant_idx ON durable_schedules (tenant_id);',
];

const TENANT_COLUMN = /tenant_(id|kind)/;

/** True when `err` (or an error it wraps) says a tenancy column does not exist. */
export function isMissingTenantColumn(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    const message = typeof e.message === 'string' ? e.message : '';
    if (TENANT_COLUMN.test(message)) {
      // Postgres: SQLSTATE 42703 (undefined_column). SQLite / libSQL: "no such column".
      if (e.code === '42703' || /does not exist/.test(message) || /no such column/i.test(message)) {
        return true;
      }
    }
    cur = e.cause;
  }
  return false;
}

/** The boot error for a database without the tenancy columns. */
export class MissingTenantColumnsError extends Error {
  constructor(dialect: 'pg' | 'sqlite', cause: unknown) {
    const statements = dialect === 'pg' ? PG_STATEMENTS : SQLITE_STATEMENTS;
    const fix =
      dialect === 'pg'
        ? "Generate a migration with drizzle-kit (`drizzle-kit generate`) from the store schema and apply it, or turn on the module's `autoSchema`, which adds them on boot."
        : 'Generate a migration with drizzle-kit (`drizzle-kit generate`) from the store schema and apply it.';
    super(
      [
        '[nestjs-durable] The durable tables are missing the tenancy columns (tenant_id, tenant_kind).',
        'This version of the Drizzle store reads them on every run and schedule query, even with tenancy off.',
        fix,
        'The migration must contain:',
        ...statements.map((s) => `  ${s}`),
      ].join('\n'),
      { cause },
    );
    this.name = 'MissingTenantColumnsError';
  }
}

/** Rethrow a missing-tenancy-column failure as {@link MissingTenantColumnsError}. */
export function tenantColumnsHint(dialect: 'pg' | 'sqlite'): (err: unknown) => never {
  return (err) => {
    if (isMissingTenantColumn(err)) throw new MissingTenantColumnsError(dialect, err);
    throw err;
  };
}

/** Await `query`, rethrowing a missing-tenancy-column failure as {@link MissingTenantColumnsError}. */
export async function withTenantColumnsHint<T>(
  dialect: 'pg' | 'sqlite',
  query: PromiseLike<T>,
): Promise<T> {
  try {
    return await query;
  } catch (err) {
    return tenantColumnsHint(dialect)(err);
  }
}
