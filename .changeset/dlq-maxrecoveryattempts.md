---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-store-typeorm": minor
"@dudousxd/nestjs-durable-store-prisma": minor
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable-store-drizzle": minor
"@dudousxd/nestjs-durable-dashboard": minor
"@dudousxd/nestjs-durable-codegen": minor
---

feat: dead-letter queue — `maxRecoveryAttempts` + `dead` run status

Crash recovery now counts attempts per run (`WorkflowRun.recoveryAttempts`); once a still-`running`
run exceeds the engine/module `maxRecoveryAttempts`, it's moved to the new terminal **`dead`** status
instead of being retried forever — so a poison pill that crashes the process every boot becomes an
inspectable dead-letter entry, not a crash loop. The new column is persisted by all four store
adapters (TypeORM auto-schema self-heals it; Prisma/Drizzle/MikroORM schemas updated), and `dead` is
added to the dashboard/codegen status unions. Omit `maxRecoveryAttempts` for the prior unlimited-retry behaviour.
