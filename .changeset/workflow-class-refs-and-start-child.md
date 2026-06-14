---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

feat: pass workflow **classes** instead of name strings, and a fire-and-forget `ctx.startChild`

**Workflow class refs.** Anywhere you named a workflow by string, you can now pass its class for a
same-runtime call — refactor-safe and typed — while strings stay for cross-runtime (e.g. a Python
workflow):

- `ctx.child(ShippingWorkflow, input)` — input is type-checked and the result is inferred from the
  child's `run` (no manual type parameter).
- `engine.start(CheckoutWorkflow, input)` / `WorkflowService.start(CheckoutWorkflow, input)`.
- `@Workflow({ deadLetterWorkflow: PipelineDlqWorkflow })` and the module-level `deadLetterWorkflow`.

The `@Workflow` decorator stamps the registered name on the class; `workflowName(ref)` (exported)
resolves a `WorkflowRef` (`string | WorkflowClass`) back to its name. New exported types:
`WorkflowClass`, `WorkflowRef`, `WorkflowInputOf`, `WorkflowOutputOf`, and `WORKFLOW_NAME_KEY`.

**`ctx.startChild`.** A fire-and-forget counterpart to `ctx.child`: dispatches a child once
(checkpointed, replay-safe) and returns its run id immediately instead of suspending — for side work
the parent doesn't wait on, or scatter-gather (start many, then `ctx.child` each by the same id to
join; the start is idempotent by id, so each child runs exactly once).
