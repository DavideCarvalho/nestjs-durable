/**
 * Compile-time guard for `WorkflowHandler<TInput, TOutput, A>`: a class `implements`ing it with a
 * correctly annotated `run` compiles cleanly, while a wrong input type, a mismatched `WorkflowCtx`
 * attributes generic, a missing `run`, or a wrong/non-promise output are all compile errors AT THE
 * CLASS. It also guards the alignment this interface exists to preserve: a class implementing it
 * still satisfies the pre-existing structural `WorkflowClass<TInput, TOutput>` shape `ctx.child` /
 * `engine.start` key off, and `WorkflowInputOf`/`WorkflowOutputOf` still extract exactly `TInput`/
 * `TOutput` through it. This file has no runtime assertions and is checked by `pnpm typecheck` only
 * (tsc includes src/**, excludes *.spec.ts) — see `typed-search-attributes.type-test.ts` for the
 * sibling guard over `WorkflowCtx<A>` itself.
 */
import { z } from 'zod';
import type { InferSearchAttributes, WorkflowCtx } from './interfaces';
import type { WorkflowHandler } from './workflow-handler';
import type { WorkflowClass, WorkflowInputOf, WorkflowOutputOf } from './workflow-ref';

const orderAttrs = z.object({
  tier: z.enum(['free', 'pro']),
  amount: z.number(),
});
type OrderAttrs = InferSearchAttributes<typeof orderAttrs>;

interface CheckoutInput {
  orderId: string;
}
interface CheckoutOutput {
  receiptId: string;
}

// Positive: a class implementing WorkflowHandler<In, Out, Attrs> with a correctly annotated `run`
// (matching param order/types and a Promise<Out>-returning body) compiles cleanly.
class CheckoutWorkflow implements WorkflowHandler<CheckoutInput, CheckoutOutput, OrderAttrs> {
  async run(ctx: WorkflowCtx<OrderAttrs>, input: CheckoutInput): Promise<CheckoutOutput> {
    await ctx.upsertSearchAttributes({ tier: 'pro' });
    return { receiptId: input.orderId };
  }
}

// Positive: the untyped default (no `A` type argument) still compiles for a plain SearchAttributes
// ctx, mirroring WorkflowCtx's own back-compat default.
class UntypedAttrsWorkflow implements WorkflowHandler<CheckoutInput, CheckoutOutput> {
  async run(ctx: WorkflowCtx, input: CheckoutInput): Promise<CheckoutOutput> {
    await ctx.upsertSearchAttributes({ anything: 'goes' });
    return { receiptId: input.orderId };
  }
}

// Positive: a synchronous (non-Promise) return is accepted — WorkflowHandler's return type
// deliberately matches WorkflowClass's `Promise<TOutput> | TOutput` flexibility.
class SyncWorkflow implements WorkflowHandler<CheckoutInput, CheckoutOutput> {
  run(_ctx: WorkflowCtx, input: CheckoutInput): CheckoutOutput {
    return { receiptId: input.orderId };
  }
}

// Negative: `run`'s `input` param must match the declared TInput — an unrelated shape is rejected.
class WrongInputType implements WorkflowHandler<CheckoutInput, CheckoutOutput> {
  // @ts-expect-error - `{ wrong: boolean }` is not assignable to (nor from) the declared `CheckoutInput`
  async run(_ctx: WorkflowCtx, _input: { wrong: boolean }): Promise<CheckoutOutput> {
    return { receiptId: 'x' };
  }
}

// Negative: `run`'s `ctx` must be typed against the SAME `A` the interface was declared with — a
// ctx narrowed to an unrelated search-attributes shape is rejected.
class WrongCtxAttrs implements WorkflowHandler<CheckoutInput, CheckoutOutput, OrderAttrs> {
  // @ts-expect-error - `WorkflowCtx<{ other: string }>` doesn't satisfy the declared `WorkflowCtx<OrderAttrs>`
  async run(_ctx: WorkflowCtx<{ other: string }>, input: CheckoutInput): Promise<CheckoutOutput> {
    return { receiptId: input.orderId };
  }
}

// Negative: a class declaring `implements WorkflowHandler` but never defining `run` at all.
// @ts-expect-error - class 'MissingRun' incorrectly implements WorkflowHandler: property 'run' is missing
class MissingRun implements WorkflowHandler<CheckoutInput, CheckoutOutput> {}

// Negative: `run`'s resolved output must match TOutput — an unrelated return type is rejected
// (Promise<string> here, but a bare synchronous wrong-type return is equally rejected).
class WrongOutput implements WorkflowHandler<CheckoutInput, CheckoutOutput> {
  // @ts-expect-error - `Promise<string>` is not assignable to the declared `Promise<CheckoutOutput> | CheckoutOutput`
  async run(_ctx: WorkflowCtx, _input: CheckoutInput): Promise<string> {
    return 'nope';
  }
}

// ---------------------------------------------------------------------------
// Alignment: implementing WorkflowHandler must not break the pre-existing WorkflowClass machinery
// that ctx.child / engine.start / WorkflowInputOf / WorkflowOutputOf key off.
// ---------------------------------------------------------------------------

// A class implementing WorkflowHandler<In, Out, A> still structurally satisfies WorkflowClass<In,
// Out> — so it keeps working everywhere a bare (non-`implements`) `@Workflow` class already does
// (ctx.child(CheckoutWorkflow, input), engine.start(CheckoutWorkflow, input), DurableWorkflow statics).
const _classSatisfiesWorkflowClass: WorkflowClass<CheckoutInput, CheckoutOutput> = CheckoutWorkflow;
void _classSatisfiesWorkflowClass;

// WorkflowInputOf/WorkflowOutputOf extract exactly TInput/TOutput through a class that implements
// WorkflowHandler — checked both directions (mutual assignability) since neither type alone proves
// exact equality.
declare const extractedInput: WorkflowInputOf<typeof CheckoutWorkflow>;
const _inputIsCheckoutInput: CheckoutInput = extractedInput;
const _checkoutInputIsExtractedInput: WorkflowInputOf<typeof CheckoutWorkflow> =
  {} as CheckoutInput;
void _inputIsCheckoutInput;
void _checkoutInputIsExtractedInput;

declare const extractedOutput: WorkflowOutputOf<typeof CheckoutWorkflow>;
const _outputIsCheckoutOutput: CheckoutOutput = extractedOutput;
const _checkoutOutputIsExtractedOutput: WorkflowOutputOf<typeof CheckoutWorkflow> =
  {} as CheckoutOutput;
void _outputIsCheckoutOutput;
void _checkoutOutputIsExtractedOutput;
