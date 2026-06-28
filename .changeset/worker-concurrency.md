---
"@dudousxd/nestjs-durable-transport-bullmq": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/durable-worker": minor
---

Add a `concurrency` option to every worker surface (BullMQ Worker concurrency). Defaults to 1
(unchanged), so a fanned-out batch — e.g. the N remote steps of a `gather` — can run in parallel
instead of serially. Available on `BullMQTransport({ concurrency })`, `runRedisWorker({ concurrency })`,
the NestJS in-app worker (`concurrency`), and the multi-group worker module (`concurrency` +
per-group `concurrencyByGroup`). The Python SDK gains the same knob (`Worker(concurrency=…)`).
Total parallelism is `concurrency × replicas`. See `docs/workers-when-to-use.md`.
