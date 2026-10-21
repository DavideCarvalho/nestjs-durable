---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/nestjs-durable-store-mikro-orm': patch
'@dudousxd/nestjs-durable-store-drizzle': patch
'@dudousxd/nestjs-durable-store-prisma': patch
'@dudousxd/nestjs-durable-store-typeorm': patch
'@dudousxd/nestjs-durable-testing': patch
---

Throughput for wide fans.

- **`BullMQTransport({ resultConcurrency })`.** Sets how many step results an instance handles at once (default 1). Each result resumes its run inline, so with one at a time a wide fan's results queued up behind a single run turn per pod.
- **One run's results go in order on an instance.** The engine now handles one run's step results in order on an instance, while different runs still proceed in parallel. A result resumes its run inline, and `execute` admits an instance into a lease it already holds, so two results of one run handled together ran two turns of that run concurrently. That already happened with an in-process transport, which delivers results concurrently, before this option existed.
- **Due timers come in batches.** `listDueTimers(nowMs, namespace, limit)` returns the most overdue first, at most `limit`. The engine's `resumeDueTimers` loads at most `timerBatchSize` (a new engine option, default 500) per pass and walks it in a shuffled order. Every driving instance runs that pass each tick, so a wave of thousands of due runs — a recovery after an outage, a fan's children waking together — had every instance load all of it and contend for the same leases row by row.
  - All five bundled stores implement `limit` and the ordering, and the shared store contract covers both. A custom store that ignores `limit` still works; the engine then gets the whole due set as before.
