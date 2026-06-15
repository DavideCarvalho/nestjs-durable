---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-store-typeorm": minor
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable-store-prisma": minor
"@dudousxd/nestjs-durable-store-drizzle": minor
---

feat: named events — ctx.waitForEvent + engine.publishEvent

Name-based pub/sub on top of the signal machinery, for choreography beyond point-to-point signals. A
run suspends on `ctx.waitForEvent('payment.settled', { match: { orderId }, timeoutMs })` and resumes
with the payload; `engine.publishEvent(name, payload)` (also `WorkflowService.publishEvent`) fans out
to every waiting run whose `match` the payload satisfies, returning how many it resumed. The match is
encoded in the waiter token, so the only store change is a new `listSignalWaiters(prefix)` method
(implemented across in-memory, TypeORM, MikroORM, Prisma, Drizzle) — no new schema.
