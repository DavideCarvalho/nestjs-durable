/**
 * The tiny SQL surface `DbTransport` needs, so it rides **whatever ORM/connection the app already
 * has** instead of forcing a specific one. Implement it for your ORM (adapters for TypeORM and
 * MikroORM ship below) and hand it to `new DbTransport({ executor })`. Mirrors how the durable
 * *store* is ORM-pluggable (store-typeorm / store-mikro-orm / …).
 */
export interface SqlExecutor {
  /** Drives placeholder style (`$n` vs `?`) and a couple of DDL type choices. */
  readonly dialect: 'mysql' | 'postgres';
  /** Quote/escape an identifier (table/column name) for this dialect. */
  escapeId(id: string): string;
  /** Run a statement outside a transaction. */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run `fn` inside a transaction — the claim uses `FOR UPDATE SKIP LOCKED` within it. */
  transaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;
}

export interface SqlTx {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

// ── TypeORM ──────────────────────────────────────────────────────────────────────────────────────

/** Structural slice of a TypeORM `DataSource` — avoids a hard dependency on typeorm. */
interface TypeOrmDataSourceLike {
  options: { type: string };
  driver: { escape(id: string): string };
  query(sql: string, params?: unknown[]): Promise<unknown>;
  createQueryRunner(): {
    connect(): Promise<void>;
    startTransaction(): Promise<void>;
    commitTransaction(): Promise<void>;
    rollbackTransaction(): Promise<void>;
    release(): Promise<void>;
    query(sql: string, params?: unknown[]): Promise<unknown>;
  };
}

/** Build an executor from a TypeORM `DataSource` (e.g. the one the durable store already uses). */
export function typeOrmExecutor(ds: TypeOrmDataSourceLike): SqlExecutor {
  return {
    dialect: /postgres/.test(String(ds.options.type)) ? 'postgres' : 'mysql',
    escapeId: (id) => ds.driver.escape(id),
    query: <T>(sql: string, params?: unknown[]) => ds.query(sql, params) as Promise<T[]>,
    transaction: async <T>(fn: (tx: SqlTx) => Promise<T>) => {
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        const result = await fn({
          query: <U>(sql: string, params?: unknown[]) => qr.query(sql, params) as Promise<U[]>,
        });
        await qr.commitTransaction();
        return result;
      } catch (err) {
        await qr.rollbackTransaction();
        throw err;
      } finally {
        await qr.release();
      }
    },
  };
}

// ── MikroORM ─────────────────────────────────────────────────────────────────────────────────────

/** Structural slice of a MikroORM `EntityManager` — avoids a hard dependency on @mikro-orm/core. */
interface MikroOrmEmLike {
  getPlatform(): { constructor: { name: string }; quoteIdentifier(id: string): string };
  getConnection(): {
    execute(sql: string, params?: unknown[], method?: 'all', ctx?: unknown): Promise<unknown>;
  };
  getTransactionContext?(): unknown;
  transactional<T>(cb: (em: MikroOrmEmLike) => Promise<T>): Promise<T>;
}

/**
 * Build an executor from a MikroORM `EntityManager` — i.e. **the app's own configured ORM**. Runs
 * raw SQL through `em.getConnection().execute(...)` and wraps the claim in `em.transactional(...)`,
 * threading the transaction context so `FOR UPDATE SKIP LOCKED` locks within the tx.
 */
export function mikroOrmExecutor(em: MikroOrmEmLike): SqlExecutor {
  const platform = em.getPlatform();
  return {
    dialect: /postgre/i.test(platform.constructor.name) ? 'postgres' : 'mysql',
    escapeId: (id) => platform.quoteIdentifier(id),
    query: <T>(sql: string, params?: unknown[]) =>
      em.getConnection().execute(sql, params ?? [], 'all') as Promise<T[]>,
    transaction: <T>(fn: (tx: SqlTx) => Promise<T>) =>
      em.transactional((txEm) =>
        fn({
          query: <U>(sql: string, params?: unknown[]) =>
            txEm
              .getConnection()
              .execute(sql, params ?? [], 'all', txEm.getTransactionContext?.()) as Promise<U[]>,
        }),
      ),
  };
}
