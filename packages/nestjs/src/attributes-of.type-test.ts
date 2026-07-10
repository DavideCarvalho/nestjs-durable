/**
 * Compile-time guard for `WorkflowAttributesOf<C>` / `attributesOf`: a class whose `run` annotates
 * `ctx: WorkflowCtx<A>` extracts exactly `A`; a class with a plain/untyped `ctx: WorkflowCtx` (or no
 * `@Workflow` at all, structurally) falls back to the untyped `SearchAttributes`; and the value
 * `attributesOf` returns is typed to exactly the extracted shape — not a wider or narrower one. This
 * file has no runtime assertions and is checked by `pnpm typecheck` only (tsc includes src/**,
 * excludes *.spec.ts) — mirrors `workflow-handler.type-test.ts`'s pattern for `WorkflowInputOf`/
 * `WorkflowOutputOf`.
 */
import type {
  InferSearchAttributes,
  SearchAttributes,
  WorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import { z } from 'zod';
import { type WorkflowAttributesOf, attributesOf } from './attributes-of';
import { Workflow } from './decorators';

const orderAttrs = z.object({
  tier: z.enum(['free', 'pro']),
  amount: z.number(),
});
type OrderAttrs = InferSearchAttributes<typeof orderAttrs>;

// Positive: a class whose `run` annotates `ctx: WorkflowCtx<OrderAttrs>` extracts exactly `OrderAttrs`
// through `WorkflowAttributesOf` — checked both directions (mutual assignability), since neither
// direction alone proves exact equality.
@Workflow({ name: 'checkout', searchAttributes: orderAttrs })
class CheckoutWorkflow {
  async run(ctx: WorkflowCtx<OrderAttrs>, _input: { orderId: string }): Promise<void> {
    await ctx.upsertSearchAttributes({ tier: 'pro' });
  }
}

declare const extractedAttrs: WorkflowAttributesOf<typeof CheckoutWorkflow>;
const _attrsAreOrderAttrs: OrderAttrs = extractedAttrs;
const _orderAttrsAreExtracted: WorkflowAttributesOf<typeof CheckoutWorkflow> = {} as OrderAttrs;
void _attrsAreOrderAttrs;
void _orderAttrsAreExtracted;

// Positive: `attributesOf`'s return type is exactly `OrderAttrs` too (not a wider `SearchAttributes`).
declare const readResult: ReturnType<typeof attributesOf<typeof CheckoutWorkflow>>;
const _readResultIsOrderAttrs: OrderAttrs = readResult;
const _orderAttrsIsReadResult: ReturnType<typeof attributesOf<typeof CheckoutWorkflow>> =
  {} as OrderAttrs;
void _readResultIsOrderAttrs;
void _orderAttrsIsReadResult;

// Negative: reading a property not on the declared shape is a compile error.
// @ts-expect-error - 'nonExistent' does not exist on OrderAttrs
void readResult.nonExistent;

// Positive: a class whose `run` leaves `ctx` as the plain, untyped `WorkflowCtx` falls back to the
// untyped `SearchAttributes` default — matching `WorkflowCtx`'s own back-compat default.
@Workflow({ name: 'untyped' })
class UntypedAttrsWorkflow {
  async run(ctx: WorkflowCtx, _input: unknown): Promise<void> {
    await ctx.upsertSearchAttributes({ anything: 'goes' });
  }
}

declare const untypedExtractedAttrs: WorkflowAttributesOf<typeof UntypedAttrsWorkflow>;
const _untypedIsSearchAttributes: SearchAttributes = untypedExtractedAttrs;
const _searchAttributesIsUntyped: WorkflowAttributesOf<typeof UntypedAttrsWorkflow> =
  {} as SearchAttributes;
void _untypedIsSearchAttributes;
void _searchAttributesIsUntyped;
