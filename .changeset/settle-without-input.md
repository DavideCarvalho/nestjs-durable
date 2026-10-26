---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-testing": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
---

A step's result settles its checkpoint without writing the step's input again. Through the new
optional `StateStore.settleCheckpointsIfPending`, the engine writes only what a result changes
(status, output, error, events and the two timings), with the same claim as
`saveCheckpointsIfPending`: a duplicate delivery still loses. Every bundled store implements it, and
`CodecStateStore` encodes what it writes. A step with a 100 KB input wrote about 100 KB of checkpoint
per result; it now writes a few hundred bytes. A custom store without the method keeps the
whole-row write. The store contract checks the new method, and checks that it sends none of the
step's input when the factory returns a `statementLog`.
