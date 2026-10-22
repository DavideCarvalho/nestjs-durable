import { DataSource } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import {
  durableManagedTables,
  ensureTypeOrmDurableSchema,
  typeOrmSchemaRepairWarning,
} from './schema';
import { TypeOrmStateStore } from './typeorm-state-store';

describe('durableManagedTables', () => {
  it('returns the seven durable table names', () => {
    expect(durableManagedTables().sort()).toEqual([
      'durable_buffered_events',
      'durable_buffered_signals',
      'durable_run_attributes',
      'durable_schedules',
      'durable_signal_waiters',
      'durable_step_checkpoints',
      'durable_workflow_runs',
    ]);
  });

  it('stays in sync with the registered entity schemas', () => {
    const entityTableNames = ENTITIES.map((entity) => entity.options.tableName).sort();
    expect(durableManagedTables().sort()).toEqual(entityTableNames);
  });
});

/** Boot a fresh in-memory better-sqlite3 DataSource with the durable entities (no `synchronize`). */
async function sqliteDataSource(): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [...ENTITIES],
  });
  await dataSource.initialize();
  return dataSource;
}

/** A logger that records every warning, so the repair warning is asserted without spying `console`. */
function recordingLogger(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message) => messages.push(message), messages };
}

describe('ensureTypeOrmDurableSchema repair warning (better-sqlite3)', () => {
  let dataSource: DataSource | undefined;

  afterEach(async () => {
    await dataSource?.destroy();
    dataSource = undefined;
  });

  it('logs nothing on a fresh install or on a schema that is already current', async () => {
    dataSource = await sqliteDataSource();
    const logger = recordingLogger();
    await ensureTypeOrmDurableSchema(dataSource, { logger });
    await ensureTypeOrmDurableSchema(dataSource, { logger });
    expect(logger.messages).toEqual([]);
  });

  it('logs ONE warning listing a re-added column and a re-created index', async () => {
    dataSource = await sqliteDataSource();
    await ensureTypeOrmDurableSchema(dataSource, { logger: recordingLogger() });
    await dataSource.query('ALTER TABLE "durable_workflow_runs" DROP COLUMN "origin"');
    await dataSource.query('DROP INDEX "durable_schedules_due_idx"');

    const logger = recordingLogger();
    await ensureTypeOrmDurableSchema(dataSource, { logger });

    expect(logger.messages).toHaveLength(1);
    const [message] = logger.messages;
    expect(message).toContain(
      '[nestjs-durable] store-typeorm repaired the durable schema at boot: added column durable_workflow_runs.origin; created index durable_schedules_due_idx on durable_schedules.',
    );
    expect(message).toContain('ensureTypeOrmDurableSchema');
    // The repair is applied, and the next boot is quiet again.
    const after = recordingLogger();
    await ensureTypeOrmDurableSchema(dataSource, { logger: after });
    expect(after.messages).toEqual([]);
  });

  it('reports a missing table next to existing ones without listing its own indexes', async () => {
    dataSource = await sqliteDataSource();
    await ensureTypeOrmDurableSchema(dataSource, { logger: recordingLogger() });
    await dataSource.query('DROP TABLE "durable_schedules"');

    const logger = recordingLogger();
    await ensureTypeOrmDurableSchema(dataSource, { logger });

    expect(logger.messages).toHaveLength(1);
    expect(logger.messages[0]).toContain('at boot: created table durable_schedules.');
  });

  it('routes the warning through the store option `schemaLogger`', async () => {
    dataSource = await sqliteDataSource();
    await ensureTypeOrmDurableSchema(dataSource, { logger: recordingLogger() });
    await dataSource.query('DROP INDEX "durable_runs_status_idx"');

    const logger = recordingLogger();
    await new TypeOrmStateStore(dataSource, { schemaLogger: logger }).ensureSchema();

    expect(logger.messages).toHaveLength(1);
    expect(logger.messages[0]).toContain(
      'created index durable_runs_status_idx on durable_workflow_runs',
    );
  });
});

describe('typeOrmSchemaRepairWarning', () => {
  it('joins the repairs into one sentence', () => {
    expect(typeOrmSchemaRepairWarning(['added column t.a', 'created index i on t'])).toMatch(
      /^\[nestjs-durable\] store-typeorm repaired the durable schema at boot: added column t\.a; created index i on t\. /,
    );
  });
});
