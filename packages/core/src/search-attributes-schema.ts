import type { InferSearchAttributes, SearchAttributes, SearchAttributesSchema } from './interfaces';

/**
 * Read a run's `searchAttributes` through a {@link SearchAttributesSchema}, typed to the schema's
 * inferred output. **Safe-parse semantics, deliberately lenient** — unlike
 * `ctx.upsertSearchAttributes` (which is strict: an invalid merge throws), a failed validation here
 * returns `{}` rather than throwing. This is intentional: `run.searchAttributes` may predate the
 * schema (an older deploy wrote it under a looser or absent schema, or a run started before this
 * workflow ever declared one), and a dashboard/read path crashing on old history is worse than it
 * quietly reporting no typed attributes for that run. Write-time enforcement is what keeps NEW writes
 * conformant; this is the read-side counterpart for consuming them.
 *
 * The schema's `validate` must be synchronous (matching the write-side constraint in
 * `ctx.upsertSearchAttributes`) — one returning a `Promise` throws with a clear error rather than
 * being silently awaited or silently treated as a failure.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { readSearchAttributes } from '@dudousxd/nestjs-durable-core';
 *
 * const orderAttrs = z.object({ tier: z.enum(['free', 'pro']), amount: z.number() });
 *
 * const run = await store.getRun(runId);
 * const attrs = readSearchAttributes(orderAttrs, run ?? {}); // { tier: 'pro', amount: 42 } | {}
 * ```
 */
export function readSearchAttributes<S extends SearchAttributesSchema>(
  schema: S,
  // `| null` because ORM store entities (MikroORM/TypeORM/Prisma) type the JSON column as
  // nullable — the entity row is the argument every real consumer passes.
  run: { searchAttributes?: SearchAttributes | null | undefined },
): InferSearchAttributes<S> {
  const result = schema['~standard'].validate(run.searchAttributes ?? {});
  if (result instanceof Promise) {
    throw new Error(
      "readSearchAttributes: schema validation must be synchronous (the searchAttributes schema's " +
        '`~standard.validate` returned a Promise) — async Standard Schema validators are not supported.',
    );
  }
  if (result.issues) {
    // Lenient by design (see doc comment) — old/foreign runs shouldn't crash a read path. The `{}`
    // is cast, not `Partial<InferSearchAttributes<S>>`, to keep the common case (destructuring known
    // keys straight off the result) ergonomic; callers reading untrusted history should still treat
    // every field as possibly absent.
    return {} as InferSearchAttributes<S>;
  }
  return result.value as InferSearchAttributes<S>;
}
