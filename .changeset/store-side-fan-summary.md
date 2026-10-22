---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
---

A summarized run detail and a fan page no longer read the run's whole checkpoint list.

- `StateStore` has two new optional methods. `checkpointStats(runId, { group? })` is one `GROUP BY parallel_group, status, <name kind>` that returns counts, seq and timestamp bounds and an attempt sum per bucket. `queryCheckpoints(runId, { group, excludeGroups, statuses, namePrefixes, offset, limit })` pages checkpoints in seq order. Every bundled store implements both, and `CodecStateStore` forwards them.
- Core's `summarizeRunFromStore` and `pageFanFromStore` build the same `RunDetail` and `FanPage` that `summarizeTimeline` and `pageFan` build from a full read. They read the aggregates, the rows outside wide fans, the folded `fan:` checkpoints, up to 20 failures per fan and the first child edges. While a wide child fan is in flight they also read its completed `signal:child:` rows, because only the payload tells whether a child failed.
- `StoreRunGateway` uses them when the store has both methods. Otherwise it falls back to the full read. On a 40,000-member step fan, a detail poll now reads 21 rows instead of 40,001, and a page of 100 reads 100.
- The summarized detail and the fan page carry an `etag`, derived from the run row and the checkpoint buckets. `RunDetailOptions.ifNoneMatch` and `FanPageQuery.ifNoneMatch` let the gateway answer `notModified` after reading only the run and the buckets. The options travel through `ProxyRunGateway` unchanged, so a tenant's poll costs the operator the same.
- Each store adds a `durable_step_checkpoints_group_idx` index on `(run_id, parallel_group, seq)`.
- The shared `runStateStoreContract` now expects both methods. It checks them against their in-memory references, and checks that the detail and the pages built on them match the ones built from a full read. The fixture covers step fans, child fans, folded checkpoints, failFast, partial waves and narrow fans.
