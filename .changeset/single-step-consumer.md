---
"@dudousxd/nestjs-durable": patch
"@dudousxd/nestjs-durable-transport-bullmq": minor
---

A co-located worker (`store` + `connection`) whose transport uses per-handler step queues no longer starts a second consumer on each `@Step` queue.

- nestjs: `DurableStepRegistrar` registered every `@Step` on the transport (`transport.handle`) on any driving operator, so with `BullMQTransport` the transport's own BullMQ Worker and the in-app worker both consumed `<prefix>-tasks-<step>@<partition>` and raced for each job. A step the transport's copy took ran without its context carrier and at the transport's concurrency and lock settings instead of the step consumer's (`concurrency`, `concurrencyByHandler`, `lockDuration`, `stalledInterval`, `maxStalledCount`). The registrar now skips a co-located worker when the transport declares the per-handler layout with no drain: the in-app worker runtime is then the step queues' only consumer. With `taskQueues: 'grouped'`, a draining transport, or a transport that states no layout, the transport's consumer stays, since the in-app runtime does not read the grouped `<prefix>-taskgroup` queue; such a worker does not yet get `concurrencyByHandler` or the carrier restore on its steps. A driving operator without `connection` is unchanged.
- transport-bullmq: `BullMQTransport.taskQueueLayout` states the step queue layout (`{ queues: 'per-handler' | 'grouped', drain }`). The nestjs fix reads it, so it takes effect with this transport-bullmq release or later; with an older one the registrar keeps today's behaviour.
