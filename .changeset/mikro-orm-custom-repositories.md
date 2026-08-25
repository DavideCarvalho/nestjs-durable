---
'@dudousxd/nestjs-durable-store-mikro-orm': minor
---

Ship a custom MikroORM repository per durable entity, so host apps can inject them by type

Reading a durable table from an app meant repeating the entity class as the first argument of every
call — `em.find(WorkflowRunEntity, …)`, `em.count(WorkflowRunEntity, …)` — with no place to hang the
app's own query helpers. The package now exports `WorkflowRunRepository`, `StepCheckpointRepository`,
`RunAttributeRepository`, `SignalWaiterRepository`, `BufferedSignalRepository` and
`BufferedEventRepository`, wired onto the schemas that `durableEntities()` builds and declared on the
entity classes via `[EntityRepositoryType]`, so `em.getRepository(WorkflowRunEntity)` and
`@InjectRepository(WorkflowRunEntity)` both resolve to the specific repository type.

The wiring is per schema, not per class: `durableEntities()` can be called more than once with a
different column `naming`, and each call has to produce schemas that still point at these
repositories.

Nothing changes for the engine — `MikroOrmStateStore` keeps its own queries, and the `namespace`
global filter applies to repository reads exactly as it does to `em.find`, including staying optional
(`args: false`) for a consumer that never calls `setFilterParams`.
