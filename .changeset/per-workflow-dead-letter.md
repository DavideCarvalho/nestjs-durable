---
"@dudousxd/nestjs-durable": minor
---

feat: per-workflow dead-letter handlers (`@DeadLetter()` + `@Workflow({ deadLetterWorkflow })`)

Dead-lettering is now per-workflow, not just a single global module option. A dead run's handler is
resolved in this order:

1. an inline **`@DeadLetter()`** method on the workflow class — co-located, shares the class's
   injected deps, runs as a durable workflow auto-registered as `<name>.dlq`, and receives a typed
   `DeadLetter<TInput>` payload;
2. the workflow's **`@Workflow({ deadLetterWorkflow: 'other-wf' })`** reference to another registered
   workflow;
3. the module-level **`deadLetterWorkflow`** default (unchanged), now a fallback for workflows that
   declare neither.

A workflow declaring both an inline `@DeadLetter()` and a `deadLetterWorkflow` reference fails fast at
boot (ambiguous config). DLQ routing now lives in the `WorkflowRegistrar` (which owns the `@Workflow`
metadata) instead of the module factory. New public exports: the `DeadLetter()` decorator and the
`DeadLetter<TInput>` payload type.
