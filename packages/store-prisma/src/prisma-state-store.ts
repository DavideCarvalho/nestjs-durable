import type {
  RunQuery,
  SignalWaiter,
  StateStore,
  StepCheckpoint,
  StepError,
  StepEvent,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';

/* The Prisma client is generated per-schema, so the adapter can't import a concrete one. Instead
   it depends on this structural surface — the three model delegates and the methods it uses. A
   real `PrismaClient` (with the models from prisma/schema.prisma added) satisfies it. Query-arg
   shapes are Prisma's own generics, so they're left as `any` at this single boundary; the row
   return types are precise, which is what the mapping code below relies on. */

interface RunRow {
  id: string;
  workflow: string;
  workflowVersion: string;
  status: string;
  input: unknown;
  output: unknown;
  error: unknown;
  wakeAt: bigint | null;
  lockedBy: string | null;
  lockedUntil: Date | null;
  recoveryAttempts: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CheckpointRow {
  runId: string;
  seq: number;
  name: string;
  kind: string;
  stepId: string;
  status: string;
  input: unknown;
  output: unknown;
  error: unknown;
  events: unknown;
  attempts: number;
  workerGroup: string | null;
  wakeAt: bigint | null;
  enqueuedAt: Date | null;
  startedAt: Date;
  finishedAt: Date;
}

interface WaiterRow {
  token: string;
  runId: string;
  seq: number;
}

// Prisma's per-model query args are generated generics; left as `any` at this single boundary.
type Args = any;

interface Delegate<Row> {
  create(args: Args): Promise<Row>;
  findUnique(args: Args): Promise<Row | null>;
  findMany(args?: Args): Promise<Row[]>;
  update(args: Args): Promise<Row>;
  updateMany(args: Args): Promise<{ count: number }>;
  upsert(args: Args): Promise<Row>;
  delete(args: Args): Promise<Row>;
}

export interface DurablePrismaClient {
  durableWorkflowRun: Delegate<RunRow>;
  durableStepCheckpoint: Delegate<CheckpointRow>;
  durableSignalWaiter: Delegate<WaiterRow>;
}

/**
 * Prisma-backed `StateStore`. Pass your `PrismaClient` after adding the models from
 * `prisma/schema.prisma` to your schema. JSON columns carry the run/step payloads directly;
 * `wakeAt` is a `BigInt` (epoch ms).
 */
export class PrismaStateStore implements StateStore {
  constructor(private readonly db: DurablePrismaClient) {}

  async createRun(run: WorkflowRun): Promise<void> {
    await this.db.durableWorkflowRun.create({ data: toRunData(run) });
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    await this.db.durableWorkflowRun.update({ where: { id: runId }, data: toRunPatch(patch) });
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const row = await this.db.durableWorkflowRun.findUnique({ where: { id: runId } });
    return row ? fromRunRow(row) : null;
  }

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const row = await this.db.durableStepCheckpoint.findUnique({
      where: { runId_seq: { runId, seq } },
    });
    return row ? fromCheckpointRow(row) : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    const data = toCheckpointData(checkpoint);
    await this.db.durableStepCheckpoint.upsert({
      where: { runId_seq: { runId: checkpoint.runId, seq: checkpoint.seq } },
      create: data,
      update: data,
    });
  }

  async listIncompleteRuns(): Promise<WorkflowRun[]> {
    const rows = await this.db.durableWorkflowRun.findMany({ where: { status: 'running' } });
    return rows.map(fromRunRow);
  }

  async listDueTimers(nowMs: number): Promise<WorkflowRun[]> {
    const rows = await this.db.durableWorkflowRun.findMany({
      where: { status: 'suspended', wakeAt: { not: null, lte: BigInt(nowMs) } },
    });
    return rows.map(fromRunRow);
  }

  async tryLockRun(
    runId: string,
    owner: string,
    leaseUntilMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const result = await this.db.durableWorkflowRun.updateMany({
      where: {
        id: runId,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date(nowMs) } }],
      },
      data: { lockedBy: owner, lockedUntil: new Date(leaseUntilMs) },
    });
    return result.count === 1;
  }

  async releaseRunLock(runId: string): Promise<void> {
    await this.db.durableWorkflowRun.update({
      where: { id: runId },
      data: { lockedBy: null, lockedUntil: null },
    });
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const where: Record<string, unknown> = {};
    if (query.workflow) where.workflow = query.workflow;
    if (query.status) where.status = query.status;
    const rows = await this.db.durableWorkflowRun.findMany({
      where,
      take: query.limit,
      skip: query.offset,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(fromRunRow);
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    const rows = await this.db.durableStepCheckpoint.findMany({
      where: { runId },
      orderBy: { seq: 'asc' },
    });
    return rows.map(fromCheckpointRow);
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    await this.db.durableSignalWaiter.upsert({
      where: { token: waiter.token },
      create: { ...waiter },
      update: { runId: waiter.runId, seq: waiter.seq },
    });
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const row = await this.db.durableSignalWaiter.findUnique({ where: { token } });
    if (!row) return null;
    await this.db.durableSignalWaiter.delete({ where: { token } });
    return { token: row.token, runId: row.runId, seq: row.seq };
  }
}

const bigOrNull = (n: number | undefined) => (n == null ? null : BigInt(n));
const numOrUndef = (n: bigint | null) => (n == null ? undefined : Number(n));
const jsonOrNull = (v: unknown) => v ?? null;

function toRunData(run: WorkflowRun) {
  return {
    id: run.id,
    workflow: run.workflow,
    workflowVersion: run.workflowVersion,
    status: run.status,
    input: jsonOrNull(run.input),
    output: jsonOrNull(run.output),
    error: jsonOrNull(run.error),
    wakeAt: bigOrNull(run.wakeAt),
    lockedBy: run.lockedBy ?? null,
    lockedUntil: run.lockedUntil == null ? null : new Date(run.lockedUntil),
    recoveryAttempts: run.recoveryAttempts ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function toRunPatch(patch: Partial<WorkflowRun>) {
  const data: Record<string, unknown> = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.output !== undefined) data.output = jsonOrNull(patch.output);
  if (patch.error !== undefined) data.error = jsonOrNull(patch.error);
  if (patch.wakeAt !== undefined) data.wakeAt = bigOrNull(patch.wakeAt);
  if (patch.recoveryAttempts !== undefined) data.recoveryAttempts = patch.recoveryAttempts ?? null;
  if (patch.updatedAt !== undefined) data.updatedAt = patch.updatedAt;
  return data;
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
    wakeAt: numOrUndef(row.wakeAt),
    lockedBy: row.lockedBy ?? undefined,
    lockedUntil: row.lockedUntil == null ? undefined : row.lockedUntil.getTime(),
    recoveryAttempts: row.recoveryAttempts ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCheckpointData(cp: StepCheckpoint) {
  return {
    runId: cp.runId,
    seq: cp.seq,
    name: cp.name,
    kind: cp.kind,
    stepId: cp.stepId,
    status: cp.status,
    input: jsonOrNull(cp.input),
    output: jsonOrNull(cp.output),
    error: jsonOrNull(cp.error),
    events: jsonOrNull(cp.events),
    attempts: cp.attempts,
    workerGroup: cp.workerGroup ?? null,
    wakeAt: bigOrNull(cp.wakeAt),
    enqueuedAt: cp.enqueuedAt,
    startedAt: cp.startedAt,
    finishedAt: cp.finishedAt,
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
    wakeAt: numOrUndef(row.wakeAt),
    enqueuedAt: row.enqueuedAt ?? row.startedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
