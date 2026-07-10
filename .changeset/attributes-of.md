---
"@dudousxd/nestjs-durable": minor
---

New `attributesOf(WorkflowClass, run)`: read a run's search attributes **by workflow class**, with the
schema resolved from that class's `@Workflow({ searchAttributes })` decorator metadata — the same
by-class idiom as triggering a workflow (`ctx.child(ShippingWorkflow, input)`), so readers reference
the workflow and never re-import/re-declare its schema. The return type is inferred structurally from
the class's `run(ctx: WorkflowCtx<A>, …)` annotation — no explicit type argument needed. Delegates to
core's `readSearchAttributes` for the lenient safe-parse read (invalid/legacy/missing attributes →
`{}`). Throws a teaching error if the class isn't `@Workflow`-decorated, or declares no
`searchAttributes` schema to resolve against.
