---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-testing": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
---

A step result's settle no longer reads the step's input. It reads the step's row through the new
optional `StateStore.getCheckpointsForSettle`, which returns `getCheckpoints`' rows without their
input, left out of the query itself; the engine uses it only when the store also settles
column-wise. Every bundled store implements it and `CodecStateStore` decodes what it returns. A step
with a 100 KB input read about 100 KB back when its result landed; it now reads a few hundred bytes.
