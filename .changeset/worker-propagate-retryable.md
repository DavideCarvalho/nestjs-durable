---
"@dudousxd/nestjs-durable-worker": patch
---

Propagate a step handler's `retryable` verdict on the thin-worker path. `toError` (used by `StepWorker.processTask`) copied `message`/`code`/`stack` off a thrown `Error` but dropped `retryable`, so a thin worker that threw a non-retryable error (e.g. `Object.assign(new Error('declined'), { retryable: false })`) was retried anyway — inconsistent with the in-process/transport path (`runStepHandler` in core's `protocol.ts`), which honours it. `toError` now carries `retryable` onto the wire `StepError` when present, so the engine's durable retry (`existing.error?.retryable !== false`) respects a worker's "don't retry this" verdict.
