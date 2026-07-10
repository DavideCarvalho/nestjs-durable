/**
 * Tables this store's durable models own, physically. UNLIKE the other store adapters, this store
 * doesn't create or manage them at boot: the models in `prisma/schema.prisma` are meant to be copied
 * into YOUR OWN `schema.prisma` (see that file's header comment), and Prisma Migrate diffs whatever
 * models live in your schema — so a consumer who copied the models in already has them accounted for
 * and never needs a denylist for Prisma Migrate itself.
 *
 * This is exported anyway for the same reason the other adapters export it: any OTHER tooling that
 * introspects the database outside of `prisma migrate diff` (a raw schema dump, a second ORM/CLI
 * pointed at the same database, a linter that flags "table not in any model") needs the same fixed
 * list of table names this store's models declare via `@@map(...)`.
 *
 * ```ts
 * const skipTables = new Set(durableManagedTables());
 * ```
 *
 * Kept in sync with the `@@map(...)` table names in `prisma/schema.prisma` by `schema.spec.ts`,
 * which parses that file and asserts the two lists match — there is no single TypeScript source to
 * derive from (the schema is a `.prisma` text file copied into the consumer's own schema, not
 * imported at runtime), so the list here is intentionally a literal mirror.
 */
export function durableManagedTables(): string[] {
  return [
    'durable_workflow_runs',
    'durable_step_checkpoints',
    'durable_run_attributes',
    'durable_signal_waiters',
    'durable_buffered_signals',
  ];
}
