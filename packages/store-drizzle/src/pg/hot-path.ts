import * as drizzleOrm from 'drizzle-orm';
import { type Column, type Table, getTableColumns } from 'drizzle-orm';
import type { DrizzlePgDatabase } from './drizzle-pg-state-store';

/**
 * The store's hot path on node-postgres: the statements a workflow turn and a step result run on
 * every step, sent as constant SQL text straight to the `pg` client instead of being rebuilt by
 * drizzle's query builder on every call. Building a statement with the builder costs far more CPU
 * than sending it (profiled at ~40% of an engine's CPU with dispatched steps), and these statements
 * never change shape.
 *
 * Only node-postgres (`drizzle(pool)` / `drizzle(client)`) takes it; any other driver (postgres-js,
 * PGlite, Neon's HTTP driver, …) keeps the builder. Values go through each drizzle column's own
 * encoder and rows through its decoder, so what is written and read back is exactly what the builder
 * would write and read. A drizzle logger configured on the db still sees every statement.
 */

interface PgQueryConfig {
  name?: string;
  text: string;
  values: unknown[];
}

/** The `pg` Pool / Client surface the hot path uses. */
interface PgQueryable {
  query(config: PgQueryConfig): Promise<{ rows: Record<string, unknown>[] }>;
}

interface DrizzleLogger {
  logQuery(query: string, params: unknown[]): void;
}

export interface PgHotPathOptions {
  /**
   * Send the hot statements as NAMED prepared statements (parsed once per connection). Saves
   * Postgres a parse per statement, but needs a direct connection or a pooler that supports
   * protocol-level prepared statements (PgBouncer in transaction mode before 1.21 does not).
   * Default off.
   */
  preparedStatements?: boolean | undefined;
}

/** The node-postgres client behind a drizzle db, or `undefined` for any other driver. */
function nodePgClient(db: DrizzlePgDatabase): PgQueryable | undefined {
  const client = (db as unknown as { $client?: unknown }).$client;
  if (!client || typeof client !== 'object') return undefined;
  if (typeof (client as { query?: unknown }).query !== 'function') return undefined;
  // A pg Pool counts its clients; a pg Client carries its connection parameters. PGlite, Neon's
  // Pool and others also have a `query`, with other signatures: they keep the builder.
  const isPool = 'totalCount' in client && 'idleCount' in client;
  const isClient = 'connectionParameters' in client;
  return isPool || isClient ? (client as unknown as PgQueryable) : undefined;
}

/** The drizzle logger configured on `db`, if any (a no-op logger counts as none). */
function drizzleLogger(db: DrizzlePgDatabase): DrizzleLogger | undefined {
  const logger = (db as unknown as { session?: { logger?: unknown } }).session?.logger;
  if (!logger || typeof (logger as DrizzleLogger).logQuery !== 'function') return undefined;
  if ((logger as { constructor?: { name?: string } }).constructor?.name === 'NoopLogger') {
    return undefined;
  }
  return logger as DrizzleLogger;
}

/** drizzle's `DrizzleQueryError` where the installed drizzle has it (0.44+). */
const QueryError = (
  drizzleOrm as unknown as {
    DrizzleQueryError?: new (query: string, params: unknown[], cause?: Error) => Error;
  }
).DrizzleQueryError;

/** A short stable hash, for statement names. */
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export class PgHotPath {
  private constructor(
    private readonly client: PgQueryable,
    private readonly logger: DrizzleLogger | undefined,
    private readonly prepared: boolean,
  ) {}

  /** The hot path for `db`, or `undefined` when `db` does not run on node-postgres. */
  static for(db: DrizzlePgDatabase, options: PgHotPathOptions = {}): PgHotPath | undefined {
    const client = nodePgClient(db);
    if (!client) return undefined;
    return new PgHotPath(client, drizzleLogger(db), options.preparedStatements === true);
  }

  /** Run one statement; resolves its rows as the driver decoded them (column names as stored). */
  async query(text: string, values: unknown[]): Promise<Record<string, unknown>[]> {
    this.logger?.logQuery(text, values);
    const config: PgQueryConfig = { text, values };
    if (this.prepared) config.name = `durable_${hash(text)}`;
    try {
      return (await this.client.query(config)).rows;
    } catch (err) {
      // The shape drizzle's builder rejects with (0.44+): the driver's error as `cause`.
      throw QueryError ? new QueryError(text, values, err as Error) : err;
    }
  }
}

/**
 * How one table's rows are written and read on the hot path: its columns in a fixed order, their
 * quoted names, and drizzle's own encoders/decoders.
 */
export class TableCodec<Row extends Record<string, unknown>> {
  readonly columns: [property: string, column: Column][];
  /** `"a", "b", …` in column order. */
  readonly list: string;

  constructor(table: Table, omit: string[] = []) {
    this.columns = Object.entries(getTableColumns(table)).filter(([key]) => !omit.includes(key));
    this.list = this.columns.map(([, c]) => quote(c.name)).join(', ');
  }

  /** The quoted column name of `property`. */
  name(property: string): string {
    const found = this.columns.find(([key]) => key === property);
    if (!found) throw new Error(`no column for ${property}`);
    return quote(found[1].name);
  }

  /** A value of `property` as drizzle's builder would bind it. */
  encode(property: string, value: unknown): unknown {
    if (value == null) return null;
    const found = this.columns.find(([key]) => key === property);
    return found ? found[1].mapToDriverValue(value) : value;
  }

  /** A row's values, in column order, as drizzle's builder would bind them. */
  encodeRow(row: Partial<Row>): unknown[] {
    return this.columns.map(([key, column]) => {
      const value = row[key];
      return value == null ? null : column.mapToDriverValue(value);
    });
  }

  /** A row a statement returned, as drizzle would map it (absent / omitted columns read `null`). */
  decode(raw: Record<string, unknown>): Row {
    const row: Record<string, unknown> = {};
    for (const [key, column] of this.columns) {
      const value = raw[column.name];
      row[key] = value == null ? null : column.mapFromDriverValue(value);
    }
    return row as Row;
  }
}

export const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** `$from, $from+1, …` for `count` parameters. */
export function placeholders(from: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `$${from + i}`).join(', ');
}
