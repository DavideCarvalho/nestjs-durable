/**
 * The tag core's lifecycle publishing marks a settled run with until every subscriber got its event
 * (`LIFECYCLE_PENDING_TAG`), written out here because the peer range reaches cores older than that
 * export.
 */
export const LIFECYCLE_PENDING_TAG = 'durable:lifecycle:pending';

/**
 * The `LIKE` pattern the owed-lifecycle listing matches it with. The listing sends it as a literal,
 * never a bind parameter: a partial index serves only a query whose predicate the planner can prove
 * from the text, which a generic plan with `$1` never is.
 */
export const LIFECYCLE_PENDING_LIKE = `%"${LIFECYCLE_PENDING_TAG}"%`;

/** The Postgres partial index the owed-lifecycle listing reads instead of the whole runs table. */
export const LIFECYCLE_PENDING_INDEX = 'durable_runs_lifecycle_pending_idx';

type Query = (sql: string) => Promise<unknown>;

/**
 * Postgres: make sure the partial index `durable_runs_lifecycle_pending_idx` on the runs table's
 * `createdAt` column, over the rows whose `tags` match {@link LIFECYCLE_PENDING_LIKE}, exists and is
 * valid. Returns whether it built the index. Throws when it could not, so the caller can try again on
 * a later boot.
 *
 * Built with `CREATE INDEX CONCURRENTLY`, so writes go on while it builds on a large table, unless the
 * connection is inside a transaction block (a migration), where only a plain `CREATE INDEX` can run.
 * An invalid leftover (a concurrent build that died) is dropped and rebuilt, unless a build of it is
 * in progress (another instance booting).
 *
 * `predicate` is the indexed condition exactly as the store's query writes it (e.g.
 * `"tags" LIKE '…'`), so the planner matches the two. Statements carry no bind parameters, so any
 * driver's raw query runs them.
 */
export async function ensurePgLifecyclePendingIndex(
  query: Query,
  opts: { schema: string | undefined; table: string; createdAt: string; predicate: string },
): Promise<boolean> {
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const scope = opts.schema === undefined ? 'current_schema()' : literal(opts.schema);
  const [state] =
    ((await query(
      `SELECT i.indisvalid AS valid, EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p.index_relid = c.oid) AS building
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = ${literal(LIFECYCLE_PENDING_INDEX)} AND n.nspname = ${scope}`,
    )) as Array<{ valid: boolean; building: boolean }> | undefined) ?? [];
  if (state?.valid || state?.building) return false;
  // In a transaction block `now()` is the block's start, earlier than the statement's.
  const [tx] =
    ((await query('SELECT now() = statement_timestamp() AS autocommit')) as
      | Array<{ autocommit: boolean }>
      | undefined) ?? [];
  const concurrently = tx?.autocommit === false ? '' : 'CONCURRENTLY ';
  const qualified =
    opts.schema === undefined
      ? `"${LIFECYCLE_PENDING_INDEX}"`
      : `"${opts.schema.replace(/"/g, '""')}"."${LIFECYCLE_PENDING_INDEX}"`;
  if (state) await query(`DROP INDEX ${concurrently}IF EXISTS ${qualified}`);
  await query(
    `CREATE INDEX ${concurrently}IF NOT EXISTS "${LIFECYCLE_PENDING_INDEX}" ON ${opts.table} (${opts.createdAt}) WHERE ${opts.predicate}`,
  );
  return true;
}
