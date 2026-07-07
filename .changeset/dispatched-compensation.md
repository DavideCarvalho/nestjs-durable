---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-dashboard": minor
---

Saga compensation for dispatched steps — `ctx.step(ref, input, { compensate })`.

The undo is another `@Step` (a method reference, compile-checked to accept the
`StepUndo<TInput, TOutput>` envelope of the call it undoes — see the new `UndoOf<H>` helper — or a
name string for a cross-runtime handler, e.g. Python). On failure (or `cancel({ compensate: true })`)
the engine dispatches the registered undos durably in reverse order, each called with the
compensated step's `{ input, output }`.

The whole unwind is now checkpointed at reserved negative seqs (`-1` = first undo executed): a crash
mid-unwind resumes where it left off instead of re-running completed undos — this also applies to
`ctx.localStep` closures, whose in-process retry semantics are otherwise unchanged. The
`compensate:<step>` checkpoints make the saga visible in run detail; the dashboard renders them as
an amber Compensation section with a `compensated`/`compensating` header chip and banner, and the
client exports `splitCompensations`/`compensationSummary`/`compensationDisplayName` for consumers
rendering their own timelines.
