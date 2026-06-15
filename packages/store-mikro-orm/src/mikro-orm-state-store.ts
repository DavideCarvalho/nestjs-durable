import {
  type RunQuery,
  type SignalWaiter,
  type StateStore,
  type StepCheckpoint,
  type StepError,
  type StepEvent,
  type WorkflowRun,
  applyAttributeQuery,
} from '@dudousxd/nestjs-durable-core';
import type { MikroORM } from '@mikro-orm/core';
import { SignalWaiterEntity, StepCheckpointEntity, WorkflowRunEntity } from './entities';
import { ensureMikroOrmDurableSchema } from './schema';

/**
 * MikroORM-backed `StateStore`. Works on any MikroORM driver — Postgres, MySQL, SQLite (tested);
 * timestamps and `wakeAt` use native datetime columns. Each operation runs on a forked
 * EntityManager so it owns its unit of work.
 */
export class MikroOrmStateStore implements StateStore {
  constructor(private readonly orm: MikroORM) {}

  async ensureSchema(): Promise<void> {
    await ensureMikroOrmDurableSchema(this.orm);
  }

  async createRun(run: WorkflowRun): Promise<void> {
    const em = this.orm.em.fork();
    em.create(WorkflowRunEntity, toRunEntity(run));
    await em.flush();
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const em = this.orm.em.fork();
    const entity = await em.findOneOrFail(WorkflowRunEntity, { id: runId });
    Object.assign(entity, toRunEntity({ ...fromRunEntity(entity), ...patch } as WorkflowRun));
    await em.flush();
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const em = this.orm.em.fork();
    const entity = await em.findOne(WorkflowRunEntity, { id: runId });
    return entity ? fromRunEntity(entity) : null;
  }

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const em = this.orm.em.fork();
    const entity = await em.findOne(StepCheckpointEntity, { runId, seq });
    return entity ? fromCheckpointEntity(entity) : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    const em = this.orm.em.fork();
    await em.upsert(StepCheckpointEntity, toCheckpointEntity(checkpoint));
    await em.flush();
  }

  async listIncompleteRuns(): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(WorkflowRunEntity, { status: 'running' });
    return rows.map(fromRunEntity);
  }

  async listPendingRuns(limit: number): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(
      WorkflowRunEntity,
      { status: 'pending' },
      { orderBy: { createdAt: 'asc' }, limit }, // FIFO dispatch
    );
    return rows.map(fromRunEntity);
  }

  async listDueTimers(nowMs: number): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(WorkflowRunEntity, {
      status: 'suspended',
      wakeAt: { $ne: null, $lte: new Date(nowMs) },
    });
    return rows.map(fromRunEntity);
  }

  async tryLockRun(
    runId: string,
    owner: string,
    leaseUntilMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const em = this.orm.em.fork();
    const affected = await em.nativeUpdate(
      WorkflowRunEntity,
      { id: runId, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date(nowMs) } }] },
      { lockedBy: owner, lockedUntil: new Date(leaseUntilMs) },
    );
    return affected === 1;
  }

  async releaseRunLock(runId: string): Promise<void> {
    const em = this.orm.em.fork();
    await em.nativeUpdate(WorkflowRunEntity, { id: runId }, { lockedBy: null, lockedUntil: null });
  }

  async renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    const em = this.orm.em.fork();
    const affected = await em.nativeUpdate(
      WorkflowRunEntity,
      { id: runId, lockedBy: owner },
      { lockedUntil: new Date(leaseUntilMs) },
    );
    return affected === 1;
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const where: Record<string, unknown> = {};
    if (query.workflow) where.workflow = query.workflow;
    if (query.status) where.status = query.status;
    // `tags` is JSON text; match the quoted token so `etl` doesn't match `etl-foo`.
    if (query.tag) where.tags = { $like: `%"${query.tag}"%` };
    const orderBy = { createdAt: 'desc' as const }; // newest first — recent runs on top in the dashboard
    // Typed/range attribute predicates aren't portable SQL — fetch coarse rows, filter + paginate
    // in-process. Without attributes, the DB paginates.
    if (query.attributes?.length) {
      const rows = await em.find(WorkflowRunEntity, where, { orderBy });
      return applyAttributeQuery(rows.map(fromRunEntity), query);
    }
    const rows = await em.find(WorkflowRunEntity, where, {
      limit: query.limit,
      offset: query.offset,
      orderBy,
    });
    return rows.map(fromRunEntity);
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(StepCheckpointEntity, { runId }, { orderBy: { seq: 'asc' } });
    return rows.map(fromCheckpointEntity);
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    const em = this.orm.em.fork();
    await em.upsert(SignalWaiterEntity, { ...waiter });
    await em.flush();
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const em = this.orm.em.fork();
    const entity = await em.findOne(SignalWaiterEntity, { token });
    if (!entity) return null;
    const waiter: SignalWaiter = { token: entity.token, runId: entity.runId, seq: entity.seq };
    await em.removeAndFlush(entity);
    return waiter;
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(SignalWaiterEntity, { token: { $like: `${prefix}%` } });
    return rows.map((e) => ({ token: e.token, runId: e.runId, seq: e.seq }));
  }
}

function toRunEntity(run: WorkflowRun): WorkflowRunEntity {
  const e = new WorkflowRunEntity();
  e.id = run.id;
  e.workflow = run.workflow;
  e.workflowVersion = run.workflowVersion;
  e.status = run.status;
  e.input = run.input ?? null;
  e.output = run.output ?? null;
  e.error = run.error ?? null;
  e.wakeAt = run.wakeAt == null ? undefined : new Date(run.wakeAt);
  e.lockedBy = run.lockedBy;
  e.lockedUntil = run.lockedUntil == null ? undefined : new Date(run.lockedUntil);
  e.recoveryAttempts = run.recoveryAttempts;
  e.tags = run.tags ?? null;
  e.searchAttributes = run.searchAttributes ?? null;
  e.createdAt = run.createdAt;
  e.updatedAt = run.updatedAt;
  return e;
}

function fromRunEntity(e: WorkflowRunEntity): WorkflowRun {
  return {
    id: e.id,
    workflow: e.workflow,
    workflowVersion: e.workflowVersion,
    status: e.status,
    input: e.input ?? undefined,
    output: e.output ?? undefined,
    error: (e.error ?? undefined) as StepError | undefined,
    wakeAt: e.wakeAt?.getTime(),
    lockedBy: e.lockedBy ?? undefined,
    lockedUntil: e.lockedUntil?.getTime(),
    recoveryAttempts: e.recoveryAttempts ?? undefined,
    tags: e.tags ?? undefined,
    searchAttributes: e.searchAttributes ?? undefined,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function toCheckpointEntity(cp: StepCheckpoint): StepCheckpointEntity {
  const e = new StepCheckpointEntity();
  e.runId = cp.runId;
  e.seq = cp.seq;
  e.name = cp.name;
  e.kind = cp.kind;
  e.stepId = cp.stepId;
  e.status = cp.status;
  e.input = cp.input ?? null;
  e.output = cp.output ?? null;
  e.error = cp.error ?? null;
  e.events = cp.events ?? null;
  e.attempts = cp.attempts;
  e.workerGroup = cp.workerGroup;
  e.wakeAt = cp.wakeAt == null ? undefined : new Date(cp.wakeAt);
  e.enqueuedAt = cp.enqueuedAt;
  e.startedAt = cp.startedAt;
  e.finishedAt = cp.finishedAt;
  return e;
}

function fromCheckpointEntity(e: StepCheckpointEntity): StepCheckpoint {
  return {
    runId: e.runId,
    seq: e.seq,
    name: e.name,
    kind: e.kind,
    stepId: e.stepId,
    status: e.status,
    input: e.input ?? undefined,
    output: e.output ?? undefined,
    error: (e.error ?? undefined) as StepError | undefined,
    events: (e.events ?? undefined) as StepEvent[] | undefined,
    attempts: e.attempts,
    workerGroup: e.workerGroup ?? undefined,
    wakeAt: e.wakeAt?.getTime(),
    enqueuedAt: e.enqueuedAt ?? e.startedAt,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
  };
}
