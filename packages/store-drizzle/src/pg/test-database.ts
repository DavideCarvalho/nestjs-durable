import pg from 'pg';

/**
 * Test-only (not exported, not bundled): a database of the spec's own on a shared Postgres server.
 *
 * When a db spec runs against `DURABLE_TEST_PG_URL`, every store's spec points at the same server.
 * Each store defines the `durable_*` tables its own way, so sharing one database lets one spec's
 * schema clobber another's mid-run. This returns `<base>_<suffix>` on the same server, creating it
 * when missing. Idempotent and safe when two specs race to create it.
 */
export async function dedicatedPgDatabaseUrl(baseUrl: string, suffix: string): Promise<string> {
  const target = new URL(baseUrl);
  const name = `${decodeURIComponent(target.pathname.slice(1)) || 'postgres'}_${suffix}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) {
      await admin.query(`CREATE DATABASE "${name}"`).catch((err: { code?: string }) => {
        // 42P04 duplicate_database; 23505 when a concurrent CREATE wins the catalog insert.
        if (err.code !== '42P04' && err.code !== '23505') throw err;
      });
    }
  } finally {
    await admin.end();
  }
  target.pathname = `/${name}`;
  return target.toString();
}
