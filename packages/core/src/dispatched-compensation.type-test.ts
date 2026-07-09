import type { StepUndo, UndoOf, WorkflowCtx } from './interfaces';
/**
 * Compile-time guard for `ctx.step(handler, input, { compensate })`'s ref-form type contract: the
 * compensate handler must accept `StepUndo<TInput, TOutput>` of the STEP IT'S ATTACHED TO — a
 * mismatched undo is a compile error, not a runtime one, so it can't be guarded by a vitest test.
 * This file has no runtime assertions and is checked by `pnpm typecheck` only (tsc includes
 * src/**, excludes *.spec.ts) — see `dispatched-compensation.spec.ts` for the 6 runtime tests.
 */
import type { StepRef } from './step-name-symbol';

interface BookInput {
  pax: string;
}
interface BookOutput {
  bookingId: string;
}

declare const ctx: WorkflowCtx;
declare const bookFlight: StepRef<BookInput, BookOutput>;

// Positive: a compensate ref typed exactly as `StepUndo<BookInput, BookOutput>` — the envelope this
// call's `{ input, output }` actually produces — is accepted.
export async function _acceptsMatchingUndo(): Promise<void> {
  const cancelBooking: StepRef<StepUndo<BookInput, BookOutput>, unknown> = async (undo) => {
    void undo.input.pax;
    void undo.output.bookingId;
  };
  await ctx.step(bookFlight, { pax: 'davi' }, { compensate: cancelBooking });
}

// Positive: `UndoOf<H>` derives the same `StepUndo` shape off the ORIGINAL step's method type — the
// documented `async cancelBooking(u: UndoOf<FlightService['book']>)` idiom a real `@Step` handler uses.
class FlightService {
  async book(input: BookInput): Promise<BookOutput> {
    return { bookingId: `bk_${input.pax}` };
  }
}
export function _undoOfMatchesStepUndo(
  u: UndoOf<FlightService['book']>,
): StepUndo<BookInput, BookOutput> {
  return u; // no conversion needed — UndoOf<book> IS StepUndo<BookInput, BookOutput>
}

// Negative: a compensate ref typed for an UNRELATED step's `StepUndo` is rejected — the ref form is
// checked against THIS call's TInput/TOutput, not just "any @Step-shaped function".
export async function _rejectsMismatchedUndo(): Promise<void> {
  const wrongUndo: StepRef<
    StepUndo<{ wrong: boolean }, { also: string }>,
    unknown
  > = async () => {};
  // @ts-expect-error - compensate must accept StepUndo<BookInput, BookOutput>, not an unrelated shape
  await ctx.step(bookFlight, { pax: 'davi' }, { compensate: wrongUndo });
}
