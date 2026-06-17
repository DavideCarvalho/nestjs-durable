---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

Optional opaque context carrier dispatched alongside `traceparent`: `WorkflowEngine`/`DurableModule` gain a `context?: () => Record<string, unknown>` option, injected into `RemoteTask` at all dispatch sites and surfaced in the Python SDK (`StepContext.context` / `current_context()`).
