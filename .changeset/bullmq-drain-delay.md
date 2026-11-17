---
'@dudousxd/nestjs-durable-transport-bullmq': minor
---

New `drainDelay` (seconds) and `stalledInterval` (ms) options, forwarded to every BullMQ worker. `drainDelay` now defaults to 30 (BullMQ's default is 5): a new job still wakes an idle worker at once and a delayed job runs at its time, so this only spaces out the idle `BZPOPMIN` + `moveToActive` polls of empty queues, one pair per queue. Closing a worker is not held up by it. `stalledInterval` keeps BullMQ's default unless set.
