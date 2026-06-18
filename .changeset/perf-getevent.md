---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-testing": patch
---

perf: `getEvent` and `getRunChildren` use targeted store queries instead of fetching and JS-filtering every checkpoint for a run. Adds two **optional** `StateStore` methods (`getLatestCheckpointByName`, `listCheckpointsByNamePrefix`) implemented by all first-party adapters; the engine falls back to the previous `listCheckpoints` scan when a custom store omits them, so this is non-breaking. Cuts per-call rows fetched from O(N) to O(1)/O(k).
