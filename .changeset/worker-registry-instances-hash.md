---
"@dudousxd/nestjs-durable-transport-bullmq": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable-core": minor
---

The BullMQ worker registry (worker liveness, handshake descriptors, run-queue consumers) now lives in one Redis hash per prefix, `<prefix>-workers:instances`, one field per instance, the same layout as the AdonisJS durable lib so both fleets on one Redis see each other. Readers do one `HGETALL`, reused for 30 s by every reader of the process (`readWorkerDescriptors(group, { fresh: true })` reads again, which the engine does before parking a run `blocked`), instead of a `SCAN` of the whole keyspace per read. `runRedisWorker` writes the same hash. The per-instance `-worker-heartbeat:` / `-worker-descriptor:` keys are still written for older readers (`workerRegistry.legacyWrites`, every 30 s) and read from older writers and the Python worker by one throttled `SCAN` walk (`workerRegistry.legacyScan`, at most once per 60 s); `workerRegistry.connection` keeps the hash on another connection. A clean `close()` removes the instance from the registry at once.
