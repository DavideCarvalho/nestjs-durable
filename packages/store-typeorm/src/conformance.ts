import type { StateStoreContext } from '@dudousxd/nestjs-durable-testing';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { ENTITIES, durableEntities } from './entities';
import { TypeOrmStateStore } from './typeorm-state-store';

/**
 * Build a {@link StateStoreFactory} for the cross-store contract suite over any TypeORM driver.
 * Each invocation opens a fresh DataSource and provisions the durable schema via `ensureSchema()`
 * (the production path — not `synchronize`), so the contract runs against the real DDL the adapter
 * ships. `cleanup` drops the durable tables and closes the connection, so a shared container DB is
 * left clean for the next factory call.
 */
export function makeTypeOrmStoreFactory(
  options: DataSourceOptions,
  durable: { schema?: string } = {},
): () => Promise<StateStoreContext> {
  const entities = durable.schema === undefined ? ENTITIES : durableEntities(durable);
  return async () => {
    let statements = 0;
    const log: string[] = [];
    const count = (query: string, parameters?: unknown[]) => {
      statements += 1;
      log.push(`${query} ${JSON.stringify(parameters ?? [])}`);
    };
    const dataSource = new DataSource({
      ...options,
      entities: [...entities],
      logging: ['query'],
      logger: {
        logQuery: count,
        logQueryError: () => undefined,
        logQuerySlow: () => undefined,
        logSchemaBuild: () => undefined,
        logMigration: () => undefined,
        log: () => undefined,
      },
    });
    await dataSource.initialize();
    const store = new TypeOrmStateStore(dataSource, { schema: durable.schema });
    await store.ensureSchema();
    // Clean slate even on a shared DB (a container reused across factory calls).
    await truncateAll(dataSource, durable.schema);
    return {
      store,
      peerStore: new TypeOrmStateStore(dataSource, { schema: durable.schema }),
      statements: () => statements,
      statementLog: () => log,
      cleanup: async () => {
        await truncateAll(dataSource, durable.schema);
        await dataSource.destroy();
      },
    };
  };
}

const TABLES = [
  'durable_run_attributes',
  'durable_step_checkpoints',
  'durable_signal_waiters',
  'durable_buffered_signals',
  'durable_buffered_events',
  'durable_signal_ids',
  'durable_schedules',
  'durable_workflow_runs',
];

async function truncateAll(dataSource: DataSource, schema?: string): Promise<void> {
  const q = (id: string) => dataSource.driver.escape(id);
  for (const t of TABLES) {
    const table = schema === undefined ? q(t) : `${q(schema)}.${q(t)}`;
    await dataSource.query(`DELETE FROM ${table}`).catch(() => undefined);
  }
}
