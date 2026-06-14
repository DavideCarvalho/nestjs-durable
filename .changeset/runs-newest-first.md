---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
---

fix: list runs newest-first

`store.listRuns` now orders by `createdAt DESC` (was `ASC`) across every adapter (in-memory,
TypeORM, MikroORM, Prisma, Drizzle), so the dashboard shows the most recent run on top instead of
buried at the bottom.
