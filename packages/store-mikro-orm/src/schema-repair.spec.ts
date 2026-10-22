import { MikroORM } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';
import { ensureMikroOrmDurableSchema } from './schema';

// The schema-repair warning against a REAL SQLite schema: MikroORM's own diff decides what is
// missing, so these pin the statement shapes it actually emits, not hand-written ones.

function recordingLogger(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message) => messages.push(message), messages };
}

async function initOrm(): Promise<MikroORM> {
  return MikroORM.init({ dbName: ':memory:', entities: [...ENTITIES], allowGlobalContext: true });
}

/** Forget the applied fingerprint, as an upgrade that changes the schema would. */
async function clearMarker(orm: MikroORM): Promise<void> {
  await orm.em.getConnection().execute('delete from durable_schema_meta');
}

describe('ensureMikroOrmDurableSchema repair warning (sqlite)', () => {
  let orm: MikroORM | undefined;

  afterEach(async () => {
    await orm?.close(true);
    orm = undefined;
  });

  it('logs nothing on a fresh install, on a steady-state boot, or on a re-check of a current schema', async () => {
    orm = await initOrm();
    const logger = recordingLogger();
    await ensureMikroOrmDurableSchema(orm, { logger });
    await ensureMikroOrmDurableSchema(orm, { logger });
    await clearMarker(orm);
    await ensureMikroOrmDurableSchema(orm, { logger });
    expect(logger.messages).toEqual([]);
  });

  it('logs ONE warning listing a re-added column and a re-created index', async () => {
    orm = await initOrm();
    await ensureMikroOrmDurableSchema(orm, { logger: recordingLogger() });
    const connection = orm.em.getConnection();
    await connection.execute('alter table `durable_workflow_runs` drop column `origin`');
    await connection.execute('drop index `durable_schedules_due_idx`');
    await clearMarker(orm);

    const logger = recordingLogger();
    await new MikroOrmStateStore(orm, { schemaLogger: logger }).ensureSchema();

    expect(logger.messages).toHaveLength(1);
    const [message] = logger.messages;
    expect(message).toContain(
      '[nestjs-durable] store-mikro-orm repaired the durable schema at boot:',
    );
    expect(message).toContain('added column durable_workflow_runs.origin');
    expect(message).toContain('created index durable_schedules_due_idx on durable_schedules');

    // Applied: the next full check is quiet again.
    await clearMarker(orm);
    const after = recordingLogger();
    await ensureMikroOrmDurableSchema(orm, { logger: after });
    expect(after.messages).toEqual([]);
  });

  it('reports a missing table next to existing ones', async () => {
    orm = await initOrm();
    await ensureMikroOrmDurableSchema(orm, { logger: recordingLogger() });
    await orm.em.getConnection().execute('drop table `durable_schedules`');
    await clearMarker(orm);

    const logger = recordingLogger();
    await ensureMikroOrmDurableSchema(orm, { logger });

    expect(logger.messages).toHaveLength(1);
    expect(logger.messages[0]).toContain('created table durable_schedules');
    expect(logger.messages[0]).not.toContain('created index durable_schedules_due_idx');
  });
});
