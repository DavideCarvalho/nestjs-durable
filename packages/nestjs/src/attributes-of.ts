import {
  type SearchAttributes,
  type WorkflowClass,
  type WorkflowCtx,
  readSearchAttributes,
} from '@dudousxd/nestjs-durable-core';
import { getWorkflowMeta } from './decorators';

/**
 * The search-attributes shape a `@Workflow` class declares — extracted from its `run` method's
 * `ctx: WorkflowCtx<A>` annotation, mirroring the `WorkflowInputOf`/`WorkflowOutputOf` structural-
 * typing idiom in core's `workflow-ref.ts` (which extract `run`'s `input`/return type the same way).
 * A class whose `run` leaves `ctx` untyped (or types it as the bare `WorkflowCtx`) resolves to the
 * untyped `SearchAttributes` default — matching `WorkflowCtx` itself.
 */
export type WorkflowAttributesOf<C> = C extends abstract new (
  ...args: never[]
) => {
  run(ctx: WorkflowCtx<infer A>, input: never): unknown;
}
  ? A
  : SearchAttributes;

/**
 * Read a run's search attributes **by workflow class**, with the schema resolved from that class's
 * `@Workflow({ searchAttributes })` decorator metadata — the same single-source-of-truth idiom as
 * triggering a workflow by class (`ctx.child(ShippingWorkflow, input)`, `engine.start(CheckoutWorkflow,
 * input)`): the decorator is the one place the schema lives, and every reader references the
 * WORKFLOW, never re-imports or re-declares the schema itself. The return type is inferred
 * structurally from the class's `run(ctx: WorkflowCtx<A>, …)` annotation (see
 * {@link WorkflowAttributesOf}), so a valid read is typed to `A` with no explicit type argument.
 *
 * Delegates to core's `readSearchAttributes(schema, run)` for the actual read, so the same lenient
 * safe-parse semantics apply: a run whose stored `searchAttributes` predate the schema, or fail it,
 * reads back as `{}` rather than throwing (see `readSearchAttributes`'s doc comment).
 *
 * @throws if `workflow` isn't a `@Workflow`-decorated class (no metadata at all — nothing to resolve
 * the schema from).
 * @throws if `workflow` is a `@Workflow` class that never declared a `searchAttributes` schema —
 * reading attributes by class needs one to resolve against.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { Injectable } from '@nestjs/common';
 * import {
 *   attributesOf,
 *   InferSearchAttributes,
 *   Workflow,
 *   WorkflowCtx,
 *   WorkflowHandler,
 * } from '@dudousxd/nestjs-durable';
 *
 * const orderAttrs = z.object({ tier: z.enum(['free', 'pro']), amount: z.number() });
 * type OrderAttrs = InferSearchAttributes<typeof orderAttrs>;
 *
 * @Workflow({ name: 'checkout', searchAttributes: orderAttrs })
 * class CheckoutWorkflow implements WorkflowHandler<{ orderId: string }, void, OrderAttrs> {
 *   async run(ctx: WorkflowCtx<OrderAttrs>, input: { orderId: string }): Promise<void> {
 *     await ctx.upsertSearchAttributes({ tier: 'pro', amount: 100 });
 *   }
 * }
 *
 * @Injectable()
 * class CheckoutDashboardService {
 *   constructor(private readonly store: StateStore) {}
 *
 *   async tierOf(runId: string) {
 *     const run = await this.store.getRun(runId);
 *     const attrs = attributesOf(CheckoutWorkflow, run ?? {}); // OrderAttrs
 *     return attrs.tier;
 *   }
 * }
 * ```
 */
export function attributesOf<C extends WorkflowClass>(
  workflow: C,
  run: { searchAttributes?: SearchAttributes | null | undefined },
): WorkflowAttributesOf<C> {
  // biome-ignore lint/complexity/noBannedTypes: getWorkflowMeta reads reflect-metadata off the class target, same contract as workflowName/bindWorkflowClass
  const meta = getWorkflowMeta(workflow as unknown as Function);
  if (!meta) {
    throw new Error(
      `attributesOf: ${workflow.name} is not a @Workflow class — is it decorated with @Workflow({ name, searchAttributes })?`,
    );
  }
  if (!meta.searchAttributes) {
    throw new Error(
      `attributesOf: workflow '${meta.name}' declares no searchAttributes schema — reading attributes by class requires the workflow to declare its schema: @Workflow({ name: '${meta.name}', searchAttributes: mySchema }).`,
    );
  }
  return readSearchAttributes(meta.searchAttributes, run) as WorkflowAttributesOf<C>;
}
