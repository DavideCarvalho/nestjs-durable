---
"@dudousxd/nestjs-durable": patch
---

A co-located worker (`store` + `connection`) no longer starts a second consumer on each `@Step` queue. `DurableStepRegistrar` registered every `@Step` on the transport (`transport.handle`) on any driving operator, so with an in-process-capable transport such as `BullMQTransport` the transport's own BullMQ Worker and the in-app worker both consumed `<prefix>-tasks-<step>@<partition>` and raced for each job. A step the transport's copy took ran without its context carrier and at the transport's concurrency and lock settings instead of the step consumer's (`concurrency`, `concurrencyByHandler`, `lockDuration`, `stalledInterval`, `maxStalledCount`). The registrar now skips a co-located worker, whose in-app worker runtime is the only consumer; a driving operator without `connection` still serves its steps through the transport.
