---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/durable-worker': minor
---

Class-first workflow API: `@Workflow` classes extending the new `DurableWorkflow` base gain `MyWorkflow.start(input)` (fire-and-forget — `engine.start` outside a workflow, a parent-linked `ctx.startChild` inside one) and `MyWorkflow.execute(input)` (run-and-await the typed output — `ctx.child` inside, start + wait-until-terminal outside), with input/output inferred from the subclass's own `run` signature. Powered by a new ambient workflow context (`AsyncLocalStorage`) the engine and the thin worker install around every body execution (`currentWorkflowCtx()`), per-class engine bindings written by the registrar at boot (`bindWorkflowClass`), and `waitForRun`'s new `until: 'terminal'` option.
