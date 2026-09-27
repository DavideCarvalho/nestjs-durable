import { type SQL, sql } from 'drizzle-orm';
import type { DrizzlePgDatabase } from './drizzle-pg-state-store';

/**
 * The structural `SqlExecutor` surface `@dudousxd/nestjs-durable-transport-db`'s `DbTransport` rides
 * (declared here, not imported, so this package takes no dependency on the transport).
 */
export interface DrizzlePgSqlExecutor {
  readonly dialect: 'postgres';
  escapeId(id: string): string;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(
    fn: (tx: { query<U = unknown>(sql: string, params?: unknown[]): Promise<U[]> }) => Promise<T>,
  ): Promise<T>;
}

/** Turn a `$1`-placeholder SQL string + params into a parameterized drizzle `SQL` object, so it runs
 *  through whatever driver the drizzle db wraps (node-postgres, postgres-js, PGlite, Neon, …). */
export function toDrizzleSql(text: string, params: unknown[] = []): SQL {
  const chunks: SQL[] = [];
  let last = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= params.length)
      throw new Error(`placeholder ${match[0]} has no bound parameter`);
    chunks.push(sql.raw(text.slice(last, match.index)), sql`${params[index]}`);
    last = (match.index ?? 0) + match[0].length;
  }
  chunks.push(sql.raw(text.slice(last)));
  return sql.join(chunks);
}

/** node-postgres / PGlite hand back `{ rows }`; postgres-js hands back the row array itself. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []) as T[];
}

/**
 * Build a `DbTransport` executor from your drizzle Postgres db — the broker-less, DBOS-style
 * transport (remote steps as rows, claimed with `SELECT … FOR UPDATE SKIP LOCKED`) on the SAME
 * connection pool your app and the durable store already use:
 *
 * ```ts
 * import { DbTransport } from '@dudousxd/nestjs-durable-transport-db';
 * import { DrizzlePgStateStore, drizzlePgExecutor } from '@dudousxd/nestjs-durable-store-drizzle/pg';
 *
 * DurableModule.forRoot({
 *   store: new DrizzlePgStateStore(db),
 *   transport: new DbTransport({ executor: drizzlePgExecutor(db), group: 'api' }),
 * });
 * ```
 */
export function drizzlePgExecutor(db: DrizzlePgDatabase): DrizzlePgSqlExecutor {
  return {
    dialect: 'postgres',
    escapeId: (id) => `"${id.replace(/"/g, '""')}"`,
    query: async <T>(text: string, params?: unknown[]) =>
      rowsOf<T>(await db.execute(toDrizzleSql(text, params))),
    transaction: <T>(fn: Parameters<DrizzlePgSqlExecutor['transaction']>[0]) =>
      db.transaction((tx) =>
        fn({
          query: async <U>(text: string, params?: unknown[]) =>
            rowsOf<U>(await tx.execute(toDrizzleSql(text, params))),
        }),
      ) as Promise<T>,
  };
}
