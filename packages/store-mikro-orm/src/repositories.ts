import { EntityRepository } from '@mikro-orm/core';
import type {
  BufferedEventEntity,
  BufferedSignalEntity,
  RunAttributeEntity,
  SignalWaiterEntity,
  StepCheckpointEntity,
  WorkflowRunEntity,
} from './entities';

/**
 * Custom repositories for the durable entities, so a host app can `@InjectRepository`/inject a
 * `WorkflowRunRepository` by type instead of repeating `em.find(WorkflowRunEntity, …)` with the
 * entity class as the first argument everywhere.
 *
 * They are wired per-schema inside `durableEntities()` (not with a decorator), because that factory
 * can be called more than once with different column naming and each call must produce schemas that
 * still point at these classes. Each entity also declares `[EntityRepositoryType]`, which is what
 * makes `em.getRepository(WorkflowRunEntity)` resolve to the specific type rather than the base
 * `EntityRepository`.
 *
 * The bodies are intentionally empty: the durable engine's own queries go through
 * `MikroOrmStateStore`, and a durable-owned query added here would be a second, unversioned read
 * path over the same tables. They exist as an injectable, correctly-typed handle for host code.
 */
export class WorkflowRunRepository extends EntityRepository<WorkflowRunEntity> {}

export class StepCheckpointRepository extends EntityRepository<StepCheckpointEntity> {}

export class RunAttributeRepository extends EntityRepository<RunAttributeEntity> {}

export class SignalWaiterRepository extends EntityRepository<SignalWaiterEntity> {}

export class BufferedSignalRepository extends EntityRepository<BufferedSignalEntity> {}

export class BufferedEventRepository extends EntityRepository<BufferedEventEntity> {}
