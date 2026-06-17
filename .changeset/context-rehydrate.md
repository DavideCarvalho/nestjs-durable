---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

Re-hydrate the originating context around a LOCAL step body (consume side). The engine gains an optional `rehydrate` hook (`<T>(carrier, fn) => T`) that wraps the in-process local step-handler invocation, passing the run's `context` carrier; the default is a passthrough, so behavior is byte-identical when unset. `DurableModule` wires it automatically when `@dudousxd/nestjs-context` is installed (an accessor is bound): it resolves nestjs-context's module-level `Context` singleton via a guarded dynamic import at module init and runs each local step inside `Context.deserialize(carrier, fn)`, so `Context.userRef()/tenantId()/traceId()` work ambiently inside a `@DurableStep` handler without the consumer wrapping anything. No handler signature change (the context is ambient via AsyncLocalStorage); `@dudousxd/nestjs-context` stays an optional peer (no hard/static import), and re-hydration is best-effort — an empty/undefined carrier just runs the handler normally.
