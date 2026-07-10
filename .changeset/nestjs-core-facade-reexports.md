---
'@dudousxd/nestjs-durable': minor
---

Re-export the everyday `@dudousxd/nestjs-durable-core` surface from `@dudousxd/nestjs-durable` — `RunGateway`, `RunDetail`, `RunListItem`, `RunWaiting`, `RunQuery`, `AttributeFilter`, `RunStatus`, `WorkflowRun`, `StepCheckpoint`, `WorkflowCtx`, `SearchAttributes`, `WorkflowEngine`, `EngineEvent`, and `StepLogger` (types re-exported type-only; `WorkflowEngine` as a value). Previously a consumer had to import `RUN_GATEWAY` from `@dudousxd/nestjs-durable` but its `RunGateway` type from `-core`, or the `Workflow` decorator from `@dudousxd/nestjs-durable` but `WorkflowEngine`/`WorkflowCtx` from `-core` — now both live under one import.
