---
"@dudousxd/nestjs-durable-transport-bullmq": patch
"@dudousxd/nestjs-durable-admission-redis": patch
"@dudousxd/durable-worker": patch
---

Closing while a pub/sub subscribe is still queued no longer raises an unhandled "Connection is closed." rejection; other subscribe/unsubscribe failures are logged (the worker control channel carries cancellations, so its failure is now visible). `BullMQTransport.close()` now closes workers first and the queues after them, under one `closeTimeoutMs` deadline, so a job finishing during SIGTERM can still publish its result instead of failing with "Connection is closed.".
