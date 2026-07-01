---
'@dudousxd/nestjs-durable-transport-bullmq': minor
---

Implement `dispatchStartRun` and `onStartRun` on `BullMQTransport` (P4). Messages are enqueued on `<effectivePrefix>-start-run`, respecting the existing namespace-prefix rule. Both methods follow the same BullMQ queue plumbing (`removeOnComplete`/`removeOnFail`, same JSON serialisation) as the existing tasks/results/decisions queues.
