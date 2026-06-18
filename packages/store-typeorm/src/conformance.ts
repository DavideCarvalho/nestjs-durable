import type { StateStoreContext } from '@dudousxd/nestjs-durable-testing';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities';
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
): () => Promise<StateStoreContext> {
  return async () => {
    const dataSource = new DataSource({ ...options, entities: [...ENTITIES] });
    await dataSource.initialize();
    const store = new TypeOrmStateStore(dataSource);
    await store.ensureSchema();
    // Clean slate even on a shared DB (a container reused across factory calls).
    await truncateAll(dataSource);
    return {
      store,
      cleanup: async () => {
        await truncateAll(dataSource);
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
  'durable_workflow_runs',
];

async function truncateAll(dataSource: DataSource): Promise<void> {
  const q = (id: string) => dataSource.driver.escape(id);
  for (const t of TABLES) {
    await dataSource.query(`DELETE FROM ${q(t)}`).catch(() => undefined);
  }
}
