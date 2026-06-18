import type { MikroORM } from '@mikro-orm/core';

/**
 * Idempotently create/extend the durable tables (additive, never drops). Safe to run on every
 * boot (auto-schema) and the function to call from a MikroORM migration when you disable
 * auto-schema:
 *
 * ```ts
 * export class AddDurableTables extends Migration {
 *   async up() { await ensureMikroOrmDurableSchema(this.getEntityManager().getOrm()); }
 * }
 * ```
 */
export async function ensureMikroOrmDurableSchema(orm: MikroORM): Promise<void> {
  await orm.schema.update({ safe: true });
}
