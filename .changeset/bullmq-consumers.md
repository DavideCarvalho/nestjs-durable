---
"@dudousxd/nestjs-durable-transport-bullmq": patch
"@dudousxd/durable-worker": patch
"@dudousxd/nestjs-durable": patch
---

BullMQ consumer fixes, and a way to keep CLI/REPL processes from consuming.

- `onDecision` delivers every decision to every handler registered on the transport. It used to keep only the first, so a second engine sharing the transport never received decisions.
- A second `onResult` call is a no-op. It used to start another results worker that replaced the first, and `close()` never closed the first one, so it kept consuming after shutdown.
- A `redis://` / `rediss://` connection string works. BullMQ copied a bare string onto its defaults character by character and connected to `127.0.0.1:6379` instead. This affected `BullMQTransport` and `runRedisWorker` / `startRun` (which `DurableModule`'s `connection` option feeds). The URL's host, port, credentials, db and TLS are read; query parameters are refused. New `redisUrlToOptions` / `normalizeRedisConnection` exports in `@dudousxd/durable-worker`.
- New `BullMQTransport.deferConsumers()` / `startConsumers()` and a `deferConsumers` option. They park every point-to-point consumer (tasks, results, decisions, step events, start-run, run-request), and the worker-liveness advertisement, until started.
- New `DurableModule` option `consumers: false` for producer-only processes (CLI commands, REPLs, scripts). It defers the transports' consumers before the engine subscribes and starts no co-located or thin worker consumer. The default is unchanged.
