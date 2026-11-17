---
"@dudousxd/nestjs-durable-transport-bullmq": minor
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-dashboard": minor
---

New `BullMQTransport` option `taskQueues: 'grouped'`: every step handler of a partition shares one queue (`<prefix>-taskgroup`, or `@<partition>`), the AdonisJS durable lib's grouped queue, consumed by one Worker that routes by the job's routing token, instead of one queue, Worker and blocking connection per handler. Each handler keeps its own concurrency limit (fixed or adaptive) through an in-process limiter, and priority, step timeouts and stalled recovery are unchanged. The default stays `'per-handler'`. `taskQueueDrain` (on by default with `'grouped'`) keeps consuming the other layout's queues of served handlers until they are empty, checked once a minute with one batched `EXISTS` while they are empty, so switching layouts in either direction loses no job. `GroupHealth` gains optional `queue`, `queueDepth`, `depthSampled` and `drainingDepth`, and the dashboard counts a shared queue once per partition. With 85 handlers, idle Redis load drops from 43.6 to 1.5 commands/s and connections from 179 to 9.
