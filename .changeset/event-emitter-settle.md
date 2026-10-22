---
"@dudousxd/nestjs-durable-transport-event-emitter": patch
---

A result or heartbeat handler that rejects no longer becomes an unhandled rejection (fatal under Node's default). The error goes to the new `onError` option (`new EventEmitterTransport(emitter, { onError })`, default `console.error`), and a failed result is redelivered with backoff (100ms doubling, capped at 5s) until `close()` instead of being lost. Adds `close()`.
