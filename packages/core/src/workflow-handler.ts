import type { SearchAttributes, WorkflowCtx } from './interfaces';

/**
 * The OPT-IN declaration-site contract for a `@Workflow` class: `implements WorkflowHandler<TInput,
 * TOutput, A>` pins the class's `run(ctx, input)` signature against `TInput`/`TOutput`/`A` so a wrong
 * signature — a renamed method, swapped/missing param, wrong return type — is a compile error AT THE
 * CLASS instead of surfacing later as a runtime discovery failure (the `@Workflow` decorator finds no
 * `run` it recognizes) or a silently-wrong type flowing out of `ctx.child(ThisWorkflow, …)` /
 * `engine.start(ThisWorkflow, …)`. `A` also declares the run's {@link SearchAttributes} shape, so
 * `ctx.upsertSearchAttributes` is narrowed to it inside the workflow body — see
 * {@link SearchAttributesSchema} / {@link InferSearchAttributes} for pairing it with a `@Workflow({
 * searchAttributes })` schema.
 *
 * This is a TYPES-ONLY contract: nothing reads `implements WorkflowHandler` at runtime, registration
 * still goes through the `@Workflow` decorator + reflected metadata exactly as before, and a class
 * that doesn't implement it works exactly as it always has.
 *
 * IMPORTANT caveat: TypeScript does **not** contextually infer a method's parameter types from an
 * `implements` clause the way it does for e.g. an object literal assigned to a typed variable. The
 * class still has to annotate `ctx`/`input` itself — `implements` only CHECKS that what you wrote is
 * assignable to the interface; it doesn't write the annotations for you. Leaving `run`'s params
 * unannotated still leaves them `any`/inferred-from-usage, `implements` or not.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { Workflow } from '@dudousxd/nestjs-durable';
 * import type { InferSearchAttributes, WorkflowCtx, WorkflowHandler } from '@dudousxd/nestjs-durable';
 *
 * const orderAttrs = z.object({
 *   tier: z.enum(['free', 'pro']),
 *   amount: z.number(),
 * });
 * type OrderAttrs = InferSearchAttributes<typeof orderAttrs>;
 *
 * interface CheckoutInput {
 *   orderId: string;
 * }
 * interface CheckoutOutput {
 *   receiptId: string;
 * }
 *
 * @Workflow({ name: 'checkout', searchAttributes: orderAttrs })
 * class CheckoutWorkflow implements WorkflowHandler<CheckoutInput, CheckoutOutput, OrderAttrs> {
 *   async run(ctx: WorkflowCtx<OrderAttrs>, input: CheckoutInput): Promise<CheckoutOutput> {
 *     await ctx.upsertSearchAttributes({ tier: 'pro', amount: 100 });
 *     const receiptId = await ctx.step('charge-card', { orderId: input.orderId });
 *     return { receiptId };
 *   }
 * }
 * ```
 */
export interface WorkflowHandler<
  TInput = unknown,
  TOutput = unknown,
  A extends SearchAttributes = SearchAttributes,
> {
  run(ctx: WorkflowCtx<A>, input: TInput): Promise<TOutput> | TOutput;
}
