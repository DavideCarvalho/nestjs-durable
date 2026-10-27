---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-testing": patch
---

A step fan's join barrier asks whether any step is still pending instead of counting them. Every batch
of results asked for a `COUNT(*)` over the fan's whole seq range, about 41 ms on a 40,000-step fan in
MySQL, from every pod settling results. Stores get an optional `hasCheckpoints` that reads from the top
of the range down and stops at the first match (a fan's highest seqs settle last): 0.9 ms on the same
fan. Every bundled store implements it; a store without it is asked `countCheckpoints` as before.
