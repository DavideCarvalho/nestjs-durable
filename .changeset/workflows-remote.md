---
'@dudousxd/nestjs-durable-workflows-remote': minor
---

New package: remote steps for the official `@nestjs/workflows` engine. `DurableRemoteStepsModule.forRoot({ transport })` and `remoteStep(ctx, name, { group, input, timeout, retry?, handler? })` run a step on a Node or Python durable worker over any durable transport, with no lease held while it runs: a journaled dispatch step, then `waitForAny` of the result signal (deduplicated by task id) against a timer. Remote failures follow the worker's `retryable` verdict; retries are unrolled attempts with journaled backoff. No heartbeats (documented).
