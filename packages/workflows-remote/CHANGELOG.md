# @dudousxd/nestjs-durable-workflows-remote

## 0.1.0

### Minor Changes

- [#444](https://github.com/DavideCarvalho/nestjs-durable/pull/444) [`34342e2`](https://github.com/DavideCarvalho/nestjs-durable/commit/34342e2dcd808307e5d817f3a061db61e5c45068) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New package: remote steps for the official `@nestjs/workflows` engine. `DurableRemoteStepsModule.forRoot({ transport })` and `remoteStep(ctx, name, { group, input, timeout, retry?, handler? })` run a step on a Node or Python durable worker over any durable transport, with no lease held while it runs: a journaled dispatch step, then `waitForAny` of the result signal (deduplicated by task id) against a timer. Remote failures follow the worker's `retryable` verdict; retries are unrolled attempts with journaled backoff. No heartbeats (documented).
