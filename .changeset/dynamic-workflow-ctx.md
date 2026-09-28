---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
---

New `DynamicWorkflowCtx<A>` type: `WorkflowCtx` with ONE string-addressed signature for each of its
overloaded methods (`step`, `child`, `startChild`, `all`). Every `WorkflowCtx<A>` is assignable to it,
so code that drives the ctx by names (a graph interpreter) and test fakes can depend on it — or on a
`Pick` of it — instead of re-declaring a narrow interface and reaching for `ctx as unknown as …`.
A type-test guards that `WorkflowCtx` stays assignable to it and to a hand-written interpreter-style
interface. Re-exported from `@dudousxd/nestjs-durable`.
