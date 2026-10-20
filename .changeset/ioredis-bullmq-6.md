---
"@dudousxd/nestjs-durable-transport-bullmq": patch
"@dudousxd/durable-worker": patch
"@dudousxd/nestjs-durable-admission-redis": patch
---

Support ioredis 6 and bullmq 6 alongside 5: the `ioredis` / `bullmq` peer ranges are now `^5.0.0 || ^6.0.0`, and the packages are built and tested against ioredis 6.0.0 + bullmq 6.3.17.

The only code change is a type-level one. ioredis 6 types `RedisOptions.replyMapping` as `T | undefined` but its constructor overloads as `replyMapping?: T`, so under `exactOptionalPropertyTypes` a plain `RedisOptions` matched no `new Redis(...)` overload; `BullMQTransport` and `RedisAdmissionBackend` now narrow that one key away at the call site. Runtime behaviour is unchanged, and none of bullmq 6's removed APIs (legacy repeatables, `Queue#client`, `Worker#blockingClient`, the `paused` job state, `debounce`, `Job#discard`) were in use.

Note that ioredis 6 speaks RESP3 by default; the transport's pub/sub, PING watchdog, SCAN/GET and the admission Lua script all behave the same under it. Pass `protocol: 2` in your connection options if you need the v5 wire protocol.
