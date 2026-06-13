---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-otel": minor
---

feat: propagate W3C traceparent to workers (distributed tracing)

The engine now stamps a `traceparent` on every dispatched `RemoteTask` from an optional
`traceparent` provider, so a worker (including the Python SDK) can continue the distributed trace
instead of starting a detached one. Core stays OTel-free: the otel package exports `otelTraceparent()`
(reads the active span via the registered W3C propagator) to wire in —
`new WorkflowEngine({ traceparent: () => otelTraceparent() })` — and the NestJS module exposes a
`traceparent` option. The wire field already existed; this populates it.
