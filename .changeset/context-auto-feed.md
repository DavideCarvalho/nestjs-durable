---
"@dudousxd/nestjs-durable": minor
---

Auto-feed the workflow context carrier from `@dudousxd/nestjs-context`. When the optional peer is installed (its accessor bound to the shared `CONTEXT_ACCESSOR` symbol) and the app passes no `context` option, `DurableModule` now defaults the engine's `context` reader to build `{ traceId, tenantId, userRef }` from the request-scoped accessor — so a workflow dispatched within a request automatically carries the originating context across process boundaries. The accessor is resolved structurally (no hard import; `@dudousxd/nestjs-context` is an optional peer dependency). An app-provided `context` option still wins, and with no accessor the carrier stays omitted (unchanged behavior). Exposes the `CONTEXT_ACCESSOR` token and a structural `ContextAccessor` interface.
