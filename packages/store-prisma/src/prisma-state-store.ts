import {
  type AttributeFilter,
  type RunQuery,
  type SignalWaiter,
  type StateStore,
  type StepCheckpoint,
  type StepError,
  type StepEvent,
  type WorkflowRun,
  attributeColumnFor,
  attributeOperand,
  normalizeAttributeRows,
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
  tags: unknown;
  searchAttributes: unknown;
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

interface RunAttributeRow {
  runId: string;
  key: string;
  strValue: string | null;
  numValue: number | null;
}

interface BufferedSignalRow {
  id: bigint;
  token: string;
  payload: unknown;
}

// Prisma's per-model query args are generated generics; left as `any` at this single boundary.
type Args = any;

interface Delegate<Row> {
  create(args: Args): Promise<Row>;
  createMany(args: Args): Promise<{ count: number }>;
  findUnique(args: Args): Promise<Row | null>;
  findFirst(args?: Args): Promise<Row | null>;
  findMany(args?: Args): Promise<Row[]>;
  update(args: Args): Promise<Row>;
  updateMany(args: Args): Promise<{ count: number }>;
  upsert(args: Args): Promise<Row>;
  delete(args: Args): Promise<Row>;
  deleteMany(args?: Args): Promise<{ count: number }>;
}

export interface DurablePrismaTx {
  durableWorkflowRun: Delegate<RunRow>;
  durableStepCheckpoint: Delegate<CheckpointRow>;
  durableRunAttribute: Delegate<RunAttributeRow>;
  durableSignalWaiter: Delegate<WaiterRow>;
  durableBufferedSignal: Delegate<BufferedSignalRow>;
}

export interface DurablePrismaClient extends DurablePrismaTx {
  /** Prisma's interactive-transaction form: runs `fn` with a tx-scoped client and commits on resolve. */
  $transaction<T>(fn: (tx: DurablePrismaTx) => Promise<T>): Promise<T>;
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
    await this.reindexAttributes(run.id, run.searchAttributes);
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    await this.db.durableWorkflowRun.update({ where: { id: runId }, data: toRunPatch(patch) });
    // Keep the side-table in step with the run's attributes whenever they're patched.
    if ('searchAttributes' in patch) await this.reindexAttributes(runId, patch.searchAttributes);
  }

  /** Rewrite a run's normalized attribute rows: delete the old set, insert the current one. Mirrors
   *  the in-memory store's reindex so the side-table always reflects the run's live searchAttributes. */
  private async reindexAttributes(
    runId: string,
    attributes: WorkflowRun['searchAttributes'],
  ): Promise<void> {
    await this.db.durableRunAttribute.deleteMany({ where: { runId } });
    const rows = normalizeAttributeRows(runId, attributes);
    if (rows.length) await this.db.durableRunAttribute.createMany({ data: rows });
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

  async transaction<T>(
    work: (tx: {
      raw: unknown;
      saveCheckpoint: (cp: StepCheckpoint) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(async (tx) =>
      work({
        raw: tx,
        saveCheckpoint: async (cp) => {
          const data = toCheckpointData(cp);
          await tx.durableStepCheckpoint.upsert({
            where: { runId_seq: { runId: cp.runId, seq: cp.seq } },
            create: data,
            update: data,
          });
        },
      }),
    );
  }

  async listIncompleteRuns(): Promise<WorkflowRun[]> {
    const rows = await this.db.durableWorkflowRun.findMany({ where: { status: 'running' } });
    return rows.map(fromRunRow);
  }

  async listPendingRuns(limit: number): Promise<WorkflowRun[]> {
    const rows = await this.db.durableWorkflowRun.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' }, // FIFO dispatch
      take: limit,
    });
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

  async renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    const result = await this.db.durableWorkflowRun.updateMany({
      where: { id: runId, lockedBy: owner },
      data: { lockedUntil: new Date(leaseUntilMs) },
    });
    return result.count === 1;
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const where: Record<string, unknown> = {};
    if (query.workflow) where.workflow = query.workflow;
    // `status IN (...)`; an empty set matches nothing (mirrors the in-memory store). Combined with the
    // single-value `status` via AND when both are present, so the narrower set wins.
    if (query.status && query.statuses) {
      where.AND = [{ status: query.status }, { status: { in: query.statuses } }];
    } else if (query.status) {
      where.status = query.status;
    } else if (query.statuses) {
      where.status = { in: query.statuses };
    }
    if (query.tag) where.tags = { array_contains: query.tag };
    // Typed/range attribute predicates push DOWN into SQL: each filter becomes a relation `some`
    // (EXISTS) on the normalized `durable_run_attributes` side-table, so the DB filters AND paginates
    // — no full scan + in-process filter. ANDed: a run must match every filter, so one `some` each.
    if (query.attributes?.length) {
      const existing = (where.AND as unknown[] | undefined) ?? [];
      where.AND = [...existing, ...query.attributes.map((f) => attributeSome(f))];
    }
    const orderBy = { createdAt: 'desc' as const }; // newest first — recent runs on top in the dashboard
    const rows = await this.db.durableWorkflowRun.findMany({
      where,
      take: query.limit,
      skip: query.offset,
      orderBy,
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

  async getLatestCheckpointByName(
    runId: string,
    name: string,
  ): Promise<StepCheckpoint | undefined> {
    const row = await this.db.durableStepCheckpoint.findFirst({
      where: { runId, name },
      orderBy: { seq: 'desc' },
    });
    return row ? fromCheckpointRow(row) : undefined;
  }

  async listCheckpointsByNamePrefix(runId: string, prefixes: string[]): Promise<StepCheckpoint[]> {
    if (prefixes.length === 0) return [];
    const rows = await this.db.durableStepCheckpoint.findMany({
      where: { runId, OR: prefixes.map((p) => ({ name: { startsWith: p } })) },
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

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    const rows = await this.db.durableSignalWaiter.findMany({
      where: { token: { startsWith: prefix } },
    });
    return rows.map((r) => ({ token: r.token, runId: r.runId, seq: r.seq }));
  }

  async bufferSignal(token: string, payload: unknown): Promise<void> {
    await this.db.durableBufferedSignal.create({ data: { token, payload: jsonOrNull(payload) } });
  }

  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    const row = await this.db.durableBufferedSignal.findFirst({
      where: { token },
      orderBy: { id: 'asc' },
    });
    if (!row) return null;
    await this.db.durableBufferedSignal.delete({ where: { id: row.id } });
    return { payload: row.payload ?? undefined };
  }
}

/**
 * One attribute predicate as a Prisma relation `some` filter on the side-table — compiles to an
 * EXISTS, so the predicate runs in SQL. `<>` (ne) maps to `{ not }`, which under `some` also excludes
 * runs where the attribute is absent (the missing-key-never-matches contract): `some` already
 * requires a matching row to exist. Numeric operands compare `numValue`, everything else `strValue`.
 */
function attributeSome(f: AttributeFilter): { attributes: { some: Record<string, unknown> } } {
  const col = attributeColumnFor(f); // 'numValue' | 'strValue'
  const operand = attributeOperand(f);
  const condition =
    f.op === 'eq' ? operand : f.op === 'ne' ? { not: operand } : { [f.op]: operand }; // gt/gte/lt/lte map 1:1 to Prisma operators
  return { attributes: { some: { key: f.key, [col]: condition } } };
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
    tags: jsonOrNull(run.tags),
    searchAttributes: jsonOrNull(run.searchAttributes),
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
  if ('searchAttributes' in patch) data.searchAttributes = jsonOrNull(patch.searchAttributes);
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
    tags: (row.tags as string[] | null) ?? undefined,
    searchAttributes:
      (row.searchAttributes as Record<string, string | number | boolean> | null) ?? undefined,
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
