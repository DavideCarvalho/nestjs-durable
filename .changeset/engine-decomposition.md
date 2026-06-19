---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
---

Fix: map every patchable field in the Prisma and Drizzle `updateRun` implementations (previously a subset of fields could be silently dropped on partial updates).

Internal engine refactors (behavior-preserving): extract `SingletonGate` to concentrate the singleton feature, funnel run settle/suspend transitions through a single `settleRun()`, and extract a `stepCheckpoint()` factory deduping 8 hand-built literals.
