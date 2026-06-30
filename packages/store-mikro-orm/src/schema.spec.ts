import type { MikroORM } from '@mikro-orm/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureMikroOrmDurableSchema } from './schema';

/** Minimal column shape the fingerprint reads off `meta.props`. */
interface FakeProp {
  name: string;
  fieldNames: string[];
  columnTypes: string[];
  primary: boolean;
  nullable: boolean;
  autoincrement: boolean;
  type: string;
  default: string | number | boolean | null;
}
interface FakeMeta {
  tableName: string;
  props: FakeProp[];
  indexes: Array<{ name: string; properties: string[] }>;
}
interface FakeMetadata {
  getAll: () => Map<string, FakeMeta>;
}
interface MarkerRow {
  fingerprint: string;
  applied_at: number;
}

/** The five durable tables described as MikroORM-ish metadata, enough for `computeExpectedFingerprint`. */
function durableMetadata(opts: { extraColumn?: boolean } = {}): FakeMetadata {
  const tableNames = [
    'durable_workflow_runs',
    'durable_step_checkpoints',
    'durable_run_attributes',
    'durable_signal_waiters',
    'durable_buffered_signals',
  ];
  const map = new Map<string, FakeMeta>();
  for (const tableName of tableNames) {
    const props: FakeProp[] = [
      {
        name: 'id',
        fieldNames: ['id'],
        columnTypes: ['varchar(255)'],
        primary: true,
        nullable: false,
        autoincrement: false,
        type: 'string',
        default: null,
      },
      {
        name: 'status',
        fieldNames: ['status'],
        columnTypes: ['varchar(255)'],
        primary: false,
        nullable: false,
        autoincrement: false,
        type: 'string',
        default: null,
      },
    ];
    if (opts.extraColumn) {
      props.push({
        name: 'extra',
        fieldNames: ['extra'],
        columnTypes: ['int'],
        primary: false,
        nullable: true,
        autoincrement: false,
        type: 'integer',
        default: null,
      });
    }
    map.set(tableName, {
      tableName,
      props,
      indexes: [{ name: `${tableName}_idx`, properties: ['status'] }],
    });
  }
  return { getAll: () => map };
}

/**
 * Minimal ORM double. The fingerprint gate's plumbing — the `durable_schema_meta` CREATE/SELECT/UPSERT
 * and the advisory lock — is intercepted in-memory (an in-process `marker` map stands in for the
 * marker table) so each test's own `execute` only ever sees the HEAL statements, exactly as before the
 * gate existed. Platform defaults to a non-MySQL name so collation alignment is a no-op unless a test
 * opts in. `getUpdateSchemaSQL` is a spy so tests can assert the heal was (or was not) reached.
 */
function makeOrm(
  sql: string,
  execute: (statement: string, params?: unknown[]) => Promise<unknown>,
  opts: {
    platform?: string;
    collate?: string;
    marker?: Map<string, MarkerRow>;
    getUpdateSchemaSQL?: () => Promise<string>;
    metadata?: FakeMetadata;
    trace?: string[];
  } = {},
): MikroORM {
  const platform = opts.platform ?? 'SqlitePlatform';
  const marker = opts.marker ?? new Map<string, MarkerRow>();
  const getUpdateSchemaSQL = opts.getUpdateSchemaSQL ?? (async () => sql);
  const metadata = opts.metadata ?? durableMetadata();

  async function gatedExecute(statement: string, params?: unknown[]): Promise<unknown> {
    opts.trace?.push(statement);
    const lower = statement.toLowerCase();
    if (lower.includes('durable_schema_meta')) {
      if (lower.startsWith('create table')) return undefined;
      if (lower.startsWith('select')) {
        const row = marker.get('durable');
        return row ? [{ fingerprint: row.fingerprint }] : [];
      }
      if (lower.startsWith('insert')) {
        const [id, fingerprint, appliedAt] = params ?? [];
        marker.set(String(id), { fingerprint: String(fingerprint), applied_at: Number(appliedAt) });
        return undefined;
      }
    }
    if (/get_lock|release_lock|pg_advisory/.test(lower)) {
      return [{}];
    }
    return execute(statement, params);
  }

  return {
    schema: { getUpdateSchemaSQL },
    em: {
      getConnection: () => ({ execute: gatedExecute }),
      getPlatform: () => ({ constructor: { name: platform } }),
    },
    config: { get: (key: string) => (key === 'collate' ? opts.collate : undefined) },
    getMetadata: () => metadata,
  } as unknown as MikroORM;
}

describe('ensureMikroOrmDurableSchema resilience', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skips a failing type-alignment (modify) statement instead of crashing boot', async () => {
    // longtext → json conversion fails on legacy/invalid data; the add-column must still run.
    const sql = [
      'alter table `durable_step_checkpoints` add column `foo` varchar(255) null',
      'alter table `durable_step_checkpoints` modify `events` json null',
    ].join(';\n');
    const ran: string[] = [];
    const execute = vi.fn(async (statement: string) => {
      if (/\bmodify\b/i.test(statement)) {
        throw new Error('ER_INVALID_JSON_TEXT: Missing a closing quotation mark');
      }
      ran.push(statement);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureMikroOrmDurableSchema(makeOrm(sql, execute))).resolves.toBeUndefined();

    // The required add-column ran; the failed modify was swallowed with a warning.
    expect(ran.some((s) => /add column/i.test(s))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rethrows when required structure (add column / create table) fails', async () => {
    const sql = 'alter table `durable_workflow_runs` add column `bar` varchar(255) null';
    const execute = async () => {
      throw new Error('boom');
    };

    await expect(ensureMikroOrmDurableSchema(makeOrm(sql, execute))).rejects.toThrow('boom');
  });

  it('only touches durable tables (ignores statements for other tables)', async () => {
    const sql = [
      'alter table `some_app_table` modify `col` json null',
      'alter table `durable_signal_waiters` add column `seq` int null',
    ].join(';\n');
    const ran: string[] = [];
    const execute = vi.fn(async (statement: string) => {
      ran.push(statement);
    });

    await ensureMikroOrmDurableSchema(makeOrm(sql, execute));

    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain('durable_signal_waiters');
  });

  it('applies a standalone `create index ... on durable_*` (postgres/sqlite index form)', async () => {
    // Adding an index to an existing table emits `create index` on Postgres/SQLite (vs `alter table
    // add index` on MySQL). Both must reach our durable tables; an index on a non-durable table must not.
    const sql = [
      'create index `durable_workflow_runs_status_wake_at_idx` on `durable_workflow_runs` (`status`, `wake_at`)',
      'create index `some_app_idx` on `some_app_table` (`col`)',
    ].join(';\n');
    const ran: string[] = [];
    const execute = vi.fn(async (statement: string) => {
      ran.push(statement);
    });

    await ensureMikroOrmDurableSchema(makeOrm(sql, execute));

    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain('durable_workflow_runs_status_wake_at_idx');
  });

  it('rethrows when a required `create index` on a durable table fails', async () => {
    const sql =
      'create index `durable_workflow_runs_workflow_status_idx` on `durable_workflow_runs` (`workflow`, `status`)';
    const execute = async () => {
      throw new Error('idx boom');
    };

    await expect(ensureMikroOrmDurableSchema(makeOrm(sql, execute))).rejects.toThrow('idx boom');
  });
});

describe('ensureMikroOrmDurableSchema collation alignment', () => {
  afterEach(() => vi.restoreAllMocks());

  it('converts durable tables whose collation differs from the configured collate (mysql)', async () => {
    const converts: string[] = [];
    const execute = vi.fn(async (statement: string) => {
      if (/information_schema/i.test(statement)) {
        return [{ collation: 'utf8mb4_0900_ai_ci' }];
      }
      converts.push(statement);
      return undefined;
    });

    await ensureMikroOrmDurableSchema(
      makeOrm('', execute, { platform: 'MySqlPlatform', collate: 'utf8mb4_unicode_ci' }),
    );

    // One CONVERT per durable table, deriving the charset from the collation prefix.
    expect(converts).toHaveLength(5);
    expect(
      converts.every((s) => /convert to character set utf8mb4 collate utf8mb4_unicode_ci/i.test(s)),
    ).toBe(true);
    expect(converts.some((s) => s.includes('durable_workflow_runs'))).toBe(true);
  });

  it('skips tables already at the configured collation', async () => {
    const converts: string[] = [];
    const execute = vi.fn(async (statement: string) => {
      if (/information_schema/i.test(statement)) {
        return [{ collation: 'utf8mb4_unicode_ci' }];
      }
      converts.push(statement);
      return undefined;
    });

    await ensureMikroOrmDurableSchema(
      makeOrm('', execute, { platform: 'MySqlPlatform', collate: 'utf8mb4_unicode_ci' }),
    );

    expect(converts).toHaveLength(0);
  });

  it('is a no-op on non-mysql platforms', async () => {
    const execute = vi.fn(async () => undefined);
    await ensureMikroOrmDurableSchema(
      makeOrm('', execute, { platform: 'PostgreSqlPlatform', collate: 'whatever' }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('is a no-op when no collate is configured', async () => {
    const execute = vi.fn(async () => undefined);
    await ensureMikroOrmDurableSchema(makeOrm('', execute, { platform: 'MySqlPlatform' }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('warns and continues when a CONVERT fails (non-fatal)', async () => {
    const execute = vi.fn(async (statement: string) => {
      if (/information_schema/i.test(statement)) {
        return [{ collation: 'utf8mb4_0900_ai_ci' }];
      }
      throw new Error('lock wait timeout exceeded');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      ensureMikroOrmDurableSchema(
        makeOrm('', execute, { platform: 'MySqlPlatform', collate: 'utf8mb4_unicode_ci' }),
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
  });
});

describe('ensureMikroOrmDurableSchema fingerprint gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bootstraps the marker with CREATE TABLE IF NOT EXISTS before reading the fingerprint', async () => {
    const trace: string[] = [];
    const execute = vi.fn(async () => undefined);

    await ensureMikroOrmDurableSchema(
      makeOrm('', execute, { platform: 'SqlitePlatform', marker: new Map(), trace }),
    );

    const createIndex = trace.findIndex((s) =>
      /create table if not exists durable_schema_meta/i.test(s),
    );
    const selectIndex = trace.findIndex((s) =>
      /select fingerprint from durable_schema_meta/i.test(s),
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(selectIndex).toBeGreaterThan(createIndex);
  });

  it('fresh DB runs the full heal and writes the marker; the next boot skips it entirely', async () => {
    const marker = new Map<string, MarkerRow>();
    const getUpdateSchemaSQL = vi.fn(async () => '');
    const execute = vi.fn(async (statement: string) => {
      if (/information_schema/i.test(statement)) {
        return [{ collation: 'utf8mb4_0900_ai_ci' }];
      }
      return undefined;
    });
    const orm = makeOrm('', execute, {
      platform: 'MySqlPlatform',
      collate: 'utf8mb4_unicode_ci',
      marker,
      getUpdateSchemaSQL,
    });

    // Fresh DB: no marker → full heal runs (introspection + collation probes), then marker is written.
    await ensureMikroOrmDurableSchema(orm);
    expect(getUpdateSchemaSQL).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.some(([s]) => /information_schema/i.test(s))).toBe(true);
    expect(marker.get('durable')?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // Steady state: stored fingerprint matches → no getUpdateSchemaSQL, no collation probes at all.
    getUpdateSchemaSQL.mockClear();
    execute.mockClear();
    await ensureMikroOrmDurableSchema(orm);
    expect(getUpdateSchemaSQL).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('re-heals when the metadata fingerprint changes', async () => {
    const marker = new Map<string, MarkerRow>();
    const execute = vi.fn(async () => undefined);

    const firstHeal = vi.fn(async () => '');
    await ensureMikroOrmDurableSchema(
      makeOrm('', execute, {
        platform: 'SqlitePlatform',
        marker,
        getUpdateSchemaSQL: firstHeal,
        metadata: durableMetadata(),
      }),
    );
    expect(firstHeal).toHaveBeenCalledTimes(1);
    const firstFingerprint = marker.get('durable')?.fingerprint;

    // A new column shifts the fingerprint → the stored marker is now stale → the heal runs again.
    const secondHeal = vi.fn(async () => '');
    await ensureMikroOrmDurableSchema(
      makeOrm('', execute, {
        platform: 'SqlitePlatform',
        marker,
        getUpdateSchemaSQL: secondHeal,
        metadata: durableMetadata({ extraColumn: true }),
      }),
    );
    expect(secondHeal).toHaveBeenCalledTimes(1);
    expect(marker.get('durable')?.fingerprint).not.toBe(firstFingerprint);
  });
});
