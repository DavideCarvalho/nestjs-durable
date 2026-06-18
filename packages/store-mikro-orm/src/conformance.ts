import type { StateStoreContext } from '@dudousxd/nestjs-durable-testing';
import type { MikroORM, Options } from '@mikro-orm/core';
import { ENTITIES } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';

/** Init a MikroORM instance from `options` using the supplied driver's `MikroORM.init`. Kept generic
 *  so the SQLite spec and the PG/MySQL db spec each pass their own driver package's `MikroORM`. */
type MikroOrmInit = (options: Options) => Promise<MikroORM>;

/**
 * Build a {@link StateStoreFactory} for the cross-store contract over any MikroORM driver. Each call
 * inits a fresh ORM, provisions the durable schema via `ensureSchema()` (the production
 * `updateSchema({ safe: true })` path), and truncates so a shared container DB starts clean. `cleanup`
 * truncates again and closes the ORM.
 */
export function makeMikroOrmStoreFactory(
  init: MikroOrmInit,
  options: Options,
): () => Promise<StateStoreContext> {
  return async () => {
    const orm = await init({ ...options, entities: [...ENTITIES], allowGlobalContext: true });
    const store = new MikroOrmStateStore(orm);
    await store.ensureSchema();
    await truncateAll(orm);
    return {
      store,
      cleanup: async () => {
        await truncateAll(orm);
        await orm.close(true);
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

async function truncateAll(orm: MikroORM): Promise<void> {
  const em = orm.em.fork();
  const platform = String(em.getPlatform().constructor.name).toLowerCase();
  const ch = platform.includes('mysql') || platform.includes('mariadb') ? '`' : '"';
  for (const t of TABLES) {
    await em.getConnection().execute(`DELETE FROM ${ch}${t}${ch}`).catch(() => undefined);
  }
}
