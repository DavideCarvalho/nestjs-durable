---
'@dudousxd/nestjs-durable-transport-bullmq': patch
---

A worker publishes step results in batches while an engine reads them: the results that finish while
one batch is being published go out together in the next (up to 256), as one job on the new
`<prefix>-results-batch` queue, instead of one BullMQ job per step. A 40,000-step fan costs about 37
Redis commands a step instead of 64; against a Redis with a fifth of a core it runs in 31 s instead of
47 s. A worker sends batches only while a live consumer reads that queue (checked every 5 s), so an
older engine, a fleet mid-upgrade, or the Python worker keeps getting one result per job on
`<prefix>-results`. A step's task completes only once its result's batch is on the queue, and a batch
that fails to publish goes out one result per job.
