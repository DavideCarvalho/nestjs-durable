/**
 * Compile-time guard for `WorkflowCtx<A>`: a workflow typed against a narrowed search-attributes
 * shape can only `upsertSearchAttributes` a `Partial` of that shape (and rejects attribute values
 * outside it), while the untyped default (`WorkflowCtx`, no type argument) keeps every existing
 * usage compiling exactly as before. Also guards `SearchAttributesSchema`'s `Output extends
 * SearchAttributes` bound — a schema with a nested-object output can't even be declared as one. This
 * file has no runtime assertions and is checked by `pnpm typecheck` only (tsc includes src/**,
 * excludes *.spec.ts) — see `upsert-search-attributes-schema.spec.ts` for the runtime behavior.
 */
import { z } from 'zod';
import type {
  InferSearchAttributes,
  SearchAttributes,
  SearchAttributesSchema,
  WorkflowCtx,
} from './interfaces';

const orderAttrs = z.object({
  tier: z.enum(['free', 'pro']),
  amount: z.number(),
});

type OrderAttrs = InferSearchAttributes<typeof orderAttrs>;

declare const typedCtx: WorkflowCtx<OrderAttrs>;
declare const defaultCtx: WorkflowCtx; // no type argument — the pre-existing, unparameterized usage

// Positive: a Partial of the declared shape (any subset of its keys) is accepted.
export async function _acceptsPartialOfDeclaredShape(): Promise<void> {
  await typedCtx.upsertSearchAttributes({ tier: 'pro' });
  await typedCtx.upsertSearchAttributes({ amount: 42 });
  await typedCtx.upsertSearchAttributes({ tier: 'free', amount: 0 });
  await typedCtx.upsertSearchAttributes({});
}

// Positive: back-compat — a `WorkflowCtx` with no type argument still accepts a plain
// `SearchAttributes` bag, exactly as before this feature existed.
export async function _defaultCtxStillAcceptsPlainSearchAttributes(): Promise<void> {
  const attrs: SearchAttributes = { anything: 'goes', n: 1, ok: true };
  await defaultCtx.upsertSearchAttributes(attrs);
}

// Negative: a value outside the declared `tier` union is rejected at the ctx call site.
export async function _rejectsAttributeValueNotInDeclaredShape(): Promise<void> {
  // @ts-expect-error - 'enterprise' is not a member of the declared 'tier' union ('free' | 'pro')
  await typedCtx.upsertSearchAttributes({ tier: 'enterprise' });
}

// Negative: a schema whose inferred OUTPUT has a nested object doesn't satisfy
// `StandardSchemaV1<unknown, SearchAttributes>` — declaring it as a `SearchAttributesSchema` (what
// `@Workflow({ searchAttributes })` requires) is a compile error, not a runtime surprise.
export function _rejectsNestedObjectSchema(): SearchAttributesSchema {
  // @ts-expect-error - inferred output `{ meta: { nested: string } }` doesn't extend SearchAttributes
  // (nested objects aren't string | number | boolean)
  return z.object({ meta: z.object({ nested: z.string() }) });
}
