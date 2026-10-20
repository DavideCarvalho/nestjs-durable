# @dudousxd/nestjs-durable-admission-redis

## 0.1.2

### Patch Changes

- [#353](https://github.com/DavideCarvalho/nestjs-durable/pull/353) [`314c13e`](https://github.com/DavideCarvalho/nestjs-durable/commit/314c13efa7820c95a15eb710bce3f18c0af158ee) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Support ioredis 6 and bullmq 6 alongside 5: the `ioredis` / `bullmq` peer ranges are now `^5.0.0 || ^6.0.0`, and the packages are built and tested against ioredis 6.0.0 + bullmq 6.3.17.

  The only code change is a type-level one. ioredis 6 types `RedisOptions.replyMapping` as `T | undefined` but its constructor overloads as `replyMapping?: T`, so under `exactOptionalPropertyTypes` a plain `RedisOptions` matched no `new Redis(...)` overload; `BullMQTransport` and `RedisAdmissionBackend` now narrow that one key away at the call site. Runtime behaviour is unchanged, and none of bullmq 6's removed APIs (legacy repeatables, `Queue#client`, `Worker#blockingClient`, the `paused` job state, `debounce`, `Job#discard`) were in use.

  Note that ioredis 6 speaks RESP3 by default; the transport's pub/sub, PING watchdog, SCAN/GET and the admission Lua script all behave the same under it. Pass `protocol: 2` in your connection options if you need the v5 wire protocol.

## 0.1.1

### Patch Changes

- [#344](https://github.com/DavideCarvalho/nestjs-durable/pull/344) [`717fa46`](https://github.com/DavideCarvalho/nestjs-durable/commit/717fa46fdd07993d117ca36047c70e0e45371ef4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Prevent handled workflow turn failures from creating an unhandled tracking rejection. Reject and clean up waitForRun when its store lookup fails, and contain background tenant-event lookup and initial Redis liveness failures so temporary storage errors do not terminate the worker.

## 0.1.0

### Minor Changes

- a9b0b2e: Pluggable admission backend + Redis-backed global flow control.

  The remote-step flow-control gate (`ctx.call(step, input, { queue })`) is now driven by a pluggable
  `AdmissionBackend` instead of an in-process-only controller:

  - **core** — new `AdmissionBackend` interface; the default `InMemoryAdmissionBackend` preserves the
    existing per-instance behaviour. Inject a custom backend via `new WorkflowEngine({ admission })`.
    The admit/release path is async, and an optional `onFreed` capability lets a freed slot wake this
    instance's blocked runs early instead of waiting for their retry tick.
  - **@dudousxd/nestjs-durable-admission-redis** (new) — `RedisAdmissionBackend` makes `concurrency`,
    `rateLimit`, priority **and** `fairness: 'key'` ordering GLOBAL across engine replicas, enforced by
    one atomic Lua script:

    - **Concurrency** via slot→instance ownership: a slot is reclaimed only when its owner's liveness
      heartbeat lapses, so a live pod holds it for the full step duration (no time-lease false purge)
      while a crashed pod's slots free within `instanceTtlMs`.
    - **Rate limit** via a fixed-window counter.
    - **Ordering** by priority desc → fairness round-robin by `key` → arrival order, with abandoned
      waiters pruned so a cancelled run can't deadlock the rest as a phantom best-waiter.

    The arrival tiebreak direction is configurable per queue via `QueueConfig.order: 'fifo' | 'lifo'`
    (default `fifo`) — `lifo` admits the most recent arrival first (a stack). Honored by both the
    in-process and Redis backends; orthogonal to priority and fairness.

    - **Early wake** by publishing a freed-slot signal on `release` that the engine subscribes to.

  - **nestjs** — `DurableModule.forRoot({ admission })` forwards the backend to the engine.
