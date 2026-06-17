---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
---

perf: O(N) replay and single-query TypeORM writes — batch-load checkpoints once per execution into a seq→checkpoint map (serving the completed replay prefix from memory with a store fallback for positions written after the snapshot), replacing the O(N²) per-resume `getCheckpoint` round-trips. TypeORM `updateRun` is now a single `UPDATE` and `saveCheckpoint` an `upsert`.
