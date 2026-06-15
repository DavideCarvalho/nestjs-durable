---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
---

Close the transport on graceful shutdown, not just drain the engine.

`WorkflowRegistrar.onApplicationShutdown` drained in-flight runs but left the transport open, so a
deploy left the broker workers consuming and connections to time out. It now closes the transport(s)
*after* the drain (so in-flight runs can still dispatch/await their remote steps while draining). Adds
an optional `close?()` to the `Transport` interface — a no-op for in-process transports; the BullMQ
transport already implemented it. Remember this only fires if the app calls `app.enableShutdownHooks()`.
