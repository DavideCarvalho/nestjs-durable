---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

New opt-in `WorkflowHandler<TInput, TOutput, A>` interface: `implements` it on a `@Workflow` class to
pin `run(ctx, input)`'s signature at the declaration site, so a wrong signature (renamed method,
swapped/missing param, wrong return type) is a compile error at the class instead of a runtime
discovery failure or a silently-wrong type flowing out of `ctx.child`/`engine.start`. Types-only —
registration and engine behavior are unchanged. Also extends `@dudousxd/nestjs-durable`'s core facade
re-exports with `readSearchAttributes`, `StepEvent`, `InferSearchAttributes`, `SearchAttributesSchema`,
and `WorkflowHandler`.
