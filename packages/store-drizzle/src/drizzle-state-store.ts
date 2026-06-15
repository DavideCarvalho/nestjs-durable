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
import { and, asc, desc, eq, isNotNull, isNull, like, lte, or } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { signalWaiters, stepCheckpoints, workflowRuns } from './schema';

type RunRow = typeof workflowRuns.$inferSelect;
type CheckpointRow = typeof stepCheckpoints.$inferSelect;
type DrizzleSqlite = BaseSQLiteDatabase<'sync' | 'async', unknown>;

/**
 * Drizzle (SQLite / libSQL) `StateStore`. Pass a drizzle db built with `./schema`. Timestamps are
 * epoch-ms integers (SQLite's 64-bit integers hold them fine). For Postgres or MySQL, use the
 * MikroORM, TypeORM or Prisma adapter.
 */
export class DrizzleStateStore implements StateStore {
  constructor(private readonly db: DrizzleSqlite) {}

  async createRun(run: WorkflowRun): Promise<void> {
    await this.db.insert(workflowRuns).values(toRunRow(run));
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    await this.db.update(workflowRuns).set(toRunPatch(patch)).where(eq(workflowRuns.id, runId));
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    return rows[0] ? fromRunRow(rows[0]) : null;
  }

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const rows = await this.db
      .select()
      .from(stepCheckpoints)
      .where(and(eq(stepCheckpoints.runId, runId), eq(stepCheckpoints.seq, seq)))
      .limit(1);
    return rows[0] ? fromCheckpointRow(rows[0]) : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    const row = toCheckpointRow(checkpoint);
    await this.db
      .insert(stepCheckpoints)
      .values(row)
      .onConflictDoUpdate({ target: [stepCheckpoints.runId, stepCheckpoints.seq], set: row });
  }

  async listIncompleteRuns(): Promise<WorkflowRun[]> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.status, 'running'));
    return rows.map(fromRunRow);
  }

  async listDueTimers(nowMs: number): Promise<WorkflowRun[]> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.status, 'suspended'),
          isNotNull(workflowRuns.wakeAt),
          lte(workflowRuns.wakeAt, nowMs),
        ),
      );
    return rows.map(fromRunRow);
  }

  async tryLockRun(
    runId: string,
    owner: string,
    leaseUntilMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const result = await this.db
      .update(workflowRuns)
      .set({ lockedBy: owner, lockedUntil: leaseUntilMs })
      .where(
        and(
          eq(workflowRuns.id, runId),
          or(isNull(workflowRuns.lockedUntil), lte(workflowRuns.lockedUntil, nowMs)),
        ),
      );
    return (result as { changes?: number }).changes === 1;
  }

  async releaseRunLock(runId: string): Promise<void> {
    await this.db
      .update(workflowRuns)
      .set({ lockedBy: null, lockedUntil: null })
      .where(eq(workflowRuns.id, runId));
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const filters = [
      query.workflow ? eq(workflowRuns.workflow, query.workflow) : undefined,
      query.status ? eq(workflowRuns.status, query.status) : undefined,
      // `tags` is JSON text; match the quoted token so `etl` doesn't match `etl-foo`.
      query.tag ? like(workflowRuns.tags, `%"${query.tag}"%`) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);
    const base = this.db
      .select()
      .from(workflowRuns)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(workflowRuns.createdAt)); // newest first — recent runs on top in the dashboard
    // Typed/range attribute predicates aren't portable SQL — fetch coarse rows, filter + paginate
    // in-process. Without attributes, the DB paginates.
    if (query.attributes?.length) {
      return applyAttributeQuery((await base).map(fromRunRow), query);
    }
    const rows = await base.limit(query.limit ?? -1).offset(query.offset ?? 0);
    return rows.map(fromRunRow);
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    const rows = await this.db
      .select()
      .from(stepCheckpoints)
      .where(eq(stepCheckpoints.runId, runId))
      .orderBy(asc(stepCheckpoints.seq));
    return rows.map(fromCheckpointRow);
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    await this.db
      .insert(signalWaiters)
      .values(waiter)
      .onConflictDoUpdate({
        target: signalWaiters.token,
        set: { runId: waiter.runId, seq: waiter.seq },
      });
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const rows = await this.db
      .select()
      .from(signalWaiters)
      .where(eq(signalWaiters.token, token))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    await this.db.delete(signalWaiters).where(eq(signalWaiters.token, token));
    return { token: row.token, runId: row.runId, seq: row.seq };
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    const rows = await this.db
      .select()
      .from(signalWaiters)
      .where(like(signalWaiters.token, `${prefix}%`));
    return rows.map((r) => ({ token: r.token, runId: r.runId, seq: r.seq }));
  }
}

function toRunRow(run: WorkflowRun): RunRow {
  return {
    id: run.id,
    workflow: run.workflow,
    workflowVersion: run.workflowVersion,
    status: run.status,
    input: run.input ?? null,
    output: run.output ?? null,
    error: run.error ?? null,
    wakeAt: run.wakeAt ?? null,
    lockedBy: run.lockedBy ?? null,
    lockedUntil: run.lockedUntil ?? null,
    recoveryAttempts: run.recoveryAttempts ?? null,
    tags: run.tags ?? null,
    searchAttributes: run.searchAttributes ?? null,
    createdAt: run.createdAt.getTime(),
    updatedAt: run.updatedAt.getTime(),
  };
}

function toRunPatch(patch: Partial<WorkflowRun>): Partial<RunRow> {
  const row: Partial<RunRow> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.output !== undefined) row.output = patch.output ?? null;
  if (patch.error !== undefined) row.error = patch.error ?? null;
  if (patch.wakeAt !== undefined) row.wakeAt = patch.wakeAt ?? null;
  if (patch.recoveryAttempts !== undefined) row.recoveryAttempts = patch.recoveryAttempts ?? null;
  if (patch.updatedAt !== undefined) row.updatedAt = patch.updatedAt.getTime();
  return row;
}

function fromRunRow(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflow: row.workflow,
    workflowVersion: row.workflowVersion,
    status: row.status as WorkflowRun['status'],
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    error: (row.error ?? undefined) as StepError | undefined,
    wakeAt: row.wakeAt ?? undefined,
    lockedBy: row.lockedBy ?? undefined,
    lockedUntil: row.lockedUntil ?? undefined,
    recoveryAttempts: row.recoveryAttempts ?? undefined,
    tags: row.tags ?? undefined,
    searchAttributes: row.searchAttributes ?? undefined,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function toCheckpointRow(cp: StepCheckpoint): CheckpointRow {
  return {
    runId: cp.runId,
    seq: cp.seq,
    name: cp.name,
    kind: cp.kind,
    stepId: cp.stepId,
    status: cp.status,
    input: cp.input ?? null,
    output: cp.output ?? null,
    error: cp.error ?? null,
    events: cp.events ?? null,
    attempts: cp.attempts,
    workerGroup: cp.workerGroup ?? null,
    wakeAt: cp.wakeAt ?? null,
    enqueuedAt: (cp.enqueuedAt ?? cp.startedAt).getTime(),
    startedAt: cp.startedAt.getTime(),
    finishedAt: cp.finishedAt.getTime(),
  };
}

function fromCheckpointRow(row: CheckpointRow): StepCheckpoint {
  return {
    runId: row.runId,
    seq: row.seq,
    name: row.name,
    kind: row.kind as StepCheckpoint['kind'],
    stepId: row.stepId,
    status: row.status as StepCheckpoint['status'],
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    error: (row.error ?? undefined) as StepError | undefined,
    events: (row.events ?? undefined) as StepEvent[] | undefined,
    attempts: row.attempts,
    workerGroup: row.workerGroup ?? undefined,
    wakeAt: row.wakeAt ?? undefined,
    enqueuedAt: row.enqueuedAt == null ? new Date(row.startedAt) : new Date(row.enqueuedAt),
    startedAt: new Date(row.startedAt),
    finishedAt: new Date(row.finishedAt),
  };
}
