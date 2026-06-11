import type {
  RunQuery,
  SignalWaiter,
  StateStore,
  StepCheckpoint,
  StepError,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { type DataSource, LessThanOrEqual } from 'typeorm';
import { SignalWaiterEntity, StepCheckpointEntity, WorkflowRunEntity } from './entities';

/**
 * TypeORM-backed `StateStore`. Postgres-first but works on any TypeORM driver; tested on
 * SQLite. Dates are stored as epoch ms to round-trip identically across drivers.
 */
export class TypeOrmStateStore implements StateStore {
  constructor(private readonly dataSource: DataSource) {}

  private runs() {
    return this.dataSource.getRepository(WorkflowRunEntity);
  }
  private checkpoints() {
    return this.dataSource.getRepository(StepCheckpointEntity);
  }
  private waiters() {
    return this.dataSource.getRepository(SignalWaiterEntity);
  }

  async createRun(run: WorkflowRun): Promise<void> {
    await this.runs().save(toRunEntity(run));
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const existing = await this.runs().findOneBy({ id: runId });
    if (!existing) throw new Error(`run ${runId} not found`);
    const merged = { ...fromRunEntity(existing), ...patch } as WorkflowRun;
    await this.runs().save(toRunEntity(merged));
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const e = await this.runs().findOneBy({ id: runId });
    return e ? fromRunEntity(e) : null;
  }

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const e = await this.checkpoints().findOneBy({ runId, seq });
    return e ? fromCheckpointEntity(e) : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    await this.checkpoints().save(toCheckpointEntity(checkpoint));
  }

  async listIncompleteRuns(): Promise<WorkflowRun[]> {
    const rows = await this.runs().findBy({ status: 'running' });
    return rows.map(fromRunEntity);
  }

  async listDueTimers(nowMs: number): Promise<WorkflowRun[]> {
    const rows = await this.runs().findBy({
      status: 'suspended',
      wakeAt: LessThanOrEqual(nowMs),
    });
    return rows.map(fromRunEntity);
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const where: Record<string, unknown> = {};
    if (query.workflow) where.workflow = query.workflow;
    if (query.status) where.status = query.status;
    const rows = await this.runs().find({
      where,
      take: query.limit,
      skip: query.offset,
      order: { createdAt: 'ASC' },
    });
    return rows.map(fromRunEntity);
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    const rows = await this.checkpoints().find({ where: { runId }, order: { seq: 'ASC' } });
    return rows.map(fromCheckpointEntity);
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    await this.waiters().save({ ...waiter });
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const e = await this.waiters().findOneBy({ token });
    if (!e) return null;
    const waiter: SignalWaiter = { token: e.token, runId: e.runId, seq: e.seq };
    await this.waiters().delete({ token });
    return waiter;
  }
}

function toRunEntity(run: WorkflowRun): WorkflowRunEntity {
  return {
    id: run.id,
    workflow: run.workflow,
    workflowVersion: run.workflowVersion,
    status: run.status,
    input: run.input ?? null,
    output: run.output ?? null,
    error: run.error ?? null,
    wakeAt: run.wakeAt ?? null,
    createdAt: run.createdAt.getTime(),
    updatedAt: run.updatedAt.getTime(),
  };
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
    wakeAt: e.wakeAt ?? undefined,
    createdAt: new Date(e.createdAt),
    updatedAt: new Date(e.updatedAt),
  };
}

function toCheckpointEntity(cp: StepCheckpoint): StepCheckpointEntity {
  return {
    runId: cp.runId,
    seq: cp.seq,
    name: cp.name,
    kind: cp.kind,
    stepId: cp.stepId,
    status: cp.status,
    output: cp.output ?? null,
    error: cp.error ?? null,
    attempts: cp.attempts,
    workerGroup: cp.workerGroup ?? null,
    wakeAt: cp.wakeAt ?? null,
    startedAt: cp.startedAt.getTime(),
    finishedAt: cp.finishedAt.getTime(),
  };
}

function fromCheckpointEntity(e: StepCheckpointEntity): StepCheckpoint {
  return {
    runId: e.runId,
    seq: e.seq,
    name: e.name,
    kind: e.kind,
    stepId: e.stepId,
    status: e.status,
    output: e.output ?? undefined,
    error: (e.error ?? undefined) as StepError | undefined,
    attempts: e.attempts,
    workerGroup: e.workerGroup ?? undefined,
    wakeAt: e.wakeAt ?? undefined,
    startedAt: new Date(e.startedAt),
    finishedAt: new Date(e.finishedAt),
  };
}
