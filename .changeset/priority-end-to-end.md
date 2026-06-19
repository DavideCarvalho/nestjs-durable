---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-testing': minor
---

Dispatch priority now reaches the broker, end-to-end.

- `ctx.call(step, input, { priority })` and `ctx.child(workflow, input, { priority })` carry their
  priority onto the dispatched `RemoteTask` / `WorkflowTask`. The third arg of `ctx.child` /
  `ctx.startChild` accepts `{ childId?, priority? }` (a bare string is still shorthand for `childId`).
- The BullMQ transport forwards that priority to the job's `priority` option, translating the
  engine's "higher = more urgent" scale onto BullMQ's inverse "lower = more urgent" so one convention
  holds end-to-end. Jobs without a priority keep the FIFO default path.
- `WorkflowRun.priority` is persisted by every store adapter (MikroORM, Drizzle, TypeORM, Prisma) so
  the priority survives the store round-trip that precedes each remote-workflow advance. Additive,
  nullable column — auto-schema/self-heal adds it to existing tables.
