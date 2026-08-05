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
  awaitingDecisionTaskId: string | null;
  recoveryAttempts: number | null;
  tags: unknown;
  searchAttributes: unknown;
  priority: number | null;
  /** NOT NULL in the schema (defaulted to `'default'`), so every row carries a real namespace. */
  namespace: string;
  origin: string | null;
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
  parallelGroup: string | null;
  wakeAt: bigint | null;
  enqueuedAt: Date | null;
  startedAt: Date;
  finishedAt: Date;
}

interface WaiterRow {
  token: string;
  runId: string;
  seq: number;
  parallelGroup: string | null;
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

interface BufferedEventRow {
  id: string;
  name: string;
  payload: unknown;
  publishedAt: bigint;
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
  durableBufferedEvent: Delegate<BufferedEventRow>;
}

export interface DurablePrismaClient extends DurablePrismaTx {
  /** Prisma's interactive-transaction form: runs `fn` with a tx-scoped client and commits on resolve. */
  $transaction<T>(fn: (tx: DurablePrismaTx) => Promise<T>): Promise<T>;
}

/**
 * The `namespace` read boundary as a spreadable Prisma `where` fragment.
 *
 * `undefined` means NO RESTRICTION — `{}` — because that is the operator (control-plane) view that
 * sees every tenant, and it is what the engine passes when it runs unscoped. It does NOT mean
 * "namespace IS NULL": the column is NOT NULL, so `{ namespace: undefined }` would be Prisma's
 * "ignore this predicate" anyway, but `{ namespace: null }` would match nothing in production while
 * still looking correct in a single-tenant test where every worker polls unscoped.
 *
 * A named namespace is plain equality, so a worker sees only its own tenant's rows — the boundary
 * {@link WorkflowRun.namespace} promises for the four worker paths (pick up, recover, resume timers,
 * time out).
 */
function namespaceWhere(namespace?: string): { namespace?: string } {
  if (namespace === undefined) return {};
  return { namespace };
}

/**
 * Prisma-backed `StateStore`. Pass your `PrismaClient` after adding the models from
 * `prisma/schema.prisma` to your schema. JSON columns carry the run/step payloads directly;
 * `wakeAt` is a `BigInt` (epoch ms).
 *
 * Every path a worker acts on is namespace-scoped when it is given one — `listPendingRuns` (pick up),
 * `listIncompleteRuns` (recover), `listDueTimers` (resume timers) and `listRuns`'s `namespace`
 * (the engine's timeout sweep). Omit it for the operator view across all tenants. Point-reads
 * (`getRun`, checkpoints) are deliberately NOT scoped, per {@link StateStore}.
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

  async deleteRun(runId: string): Promise<void> {
    // Child rows first, then the run — checkpoints, signal waiters, attribute rows.
    await this.db.durableStepCheckpoint.deleteMany({ where: { runId } });
    await this.db.durableSignalWaiter.deleteMany({ where: { runId } });
    await this.db.durableRunAttribute.deleteMany({ where: { runId } });
    await this.db.durableWorkflowRun.deleteMany({ where: { id: runId } });
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

  async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
    const rows = await this.db.durableWorkflowRun.findMany({
      where: { status: { in: ['running', 'cancelling'] }, ...namespaceWhere(namespace) },
    });
    return rows.map(fromRunRow);
  }

  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    const rows = await this.db.durableWorkflowRun.findMany({
      where: { status: 'pending', ...namespaceWhere(namespace) },
      orderBy: { createdAt: 'asc' }, // FIFO dispatch
      take: limit,
    });
    return rows.map(fromRunRow);
  }

  async listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]> {
    const rows = await this.db.durableWorkflowRun.findMany({
      where: {
        status: 'suspended',
        wakeAt: { not: null, lte: BigInt(nowMs) },
        ...namespaceWhere(namespace),
      },
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
    // Idempotent by design: releasing the lease on a run that no longer exists is a no-op, not an
    // error. The engine calls this best-effort in a `finally` AFTER the run has settled, so it can
    // race a concurrent purge/teardown — Prisma's `update({ where: { id } })` would throw P2025
    // ("No record was found for an update") on that race and, since the call is fire-and-forget on
    // the engine's terminal path, surface as an unhandled rejection. `updateMany` matches a 0-row
    // WHERE to an empty result (no throw), mirroring the in-memory store's `if (run)` guard and the
    // set-where semantics of every sibling adapter (TypeORM/MikroORM/Drizzle).
    await this.db.durableWorkflowRun.updateMany({
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
    // The tenant boundary, and NOT only a dashboard facet: the engine's `sweepTimeouts` finds the runs
    // it may cancel through `listRuns({ workflow, status, namespace })`, so an unfiltered `namespace`
    // here lets a worker serving one tenant time out another tenant's runs — a write, not a stale
    // read. Same `undefined` = no restriction rule as the poll paths above (see `namespaceWhere`),
    // which is what keeps the operator's dashboard showing every tenant by default.
    const where: Record<string, unknown> = { ...namespaceWhere(query.namespace) };
    if (query.workflow) where.workflow = query.workflow;
    // Which library registered the workflow. Plain equality, so a run whose origin is NULL (created
    // before the column existed, or registered through a path the derivation could not classify)
    // matches NO origin value — it is never folded into a bucket to make the facet look complete.
    // Unknown-origin runs are reachable only with the filter OFF, so "all origins" must stay the
    // default view; a dashboard that filtered by default would make those runs look deleted.
    if (query.origin !== undefined) where.origin = query.origin;
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
      create: {
        token: waiter.token,
        runId: waiter.runId,
        seq: waiter.seq,
        parallelGroup: waiter.parallelGroup ?? null,
      },
      update: {
        runId: waiter.runId,
        seq: waiter.seq,
        parallelGroup: waiter.parallelGroup ?? null,
      },
    });
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const row = await this.db.durableSignalWaiter.findUnique({ where: { token } });
    if (!row) return null;
    await this.db.durableSignalWaiter.delete({ where: { token } });
    return {
      token: row.token,
      runId: row.runId,
      seq: row.seq,
      parallelGroup: row.parallelGroup ?? undefined,
    };
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    const rows = await this.db.durableSignalWaiter.findMany({
      where: { token: { startsWith: prefix } },
    });
    return rows.map((r) => ({
      token: r.token,
      runId: r.runId,
      seq: r.seq,
      parallelGroup: r.parallelGroup ?? undefined,
    }));
  }

  async removeSignalWaiter(waiter: SignalWaiter): Promise<void> {
    // Exact-match delete (token AND runId AND seq): `token` is the only unique column, so a plain
    // `delete({ where: { token } })` would remove whatever row currently owns it, even if a different
    // run has since claimed the same token — `deleteMany` with all three fields is a safe no-op then.
    await this.db.durableSignalWaiter.deleteMany({
      where: { token: waiter.token, runId: waiter.runId, seq: waiter.seq },
    });
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

  async bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void> {
    await this.db.durableBufferedEvent.create({
      data: {
        id: input.id,
        name: input.name,
        payload: jsonOrNull(input.payload),
        publishedAt: BigInt(input.publishedAt),
      },
    });
  }

  async listBufferedEvents(
    name: string,
    limit: number,
  ): Promise<Array<{ id: string; payload: unknown; publishedAt: number }>> {
    const rows = await this.db.durableBufferedEvent.findMany({
      where: { name },
      orderBy: { publishedAt: 'asc' }, // oldest first
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      payload: r.payload ?? undefined,
      publishedAt: Number(r.publishedAt),
    }));
  }

  async removeBufferedEvent(id: string): Promise<boolean> {
    // deleteMany's `where: { id }` matches at most one row (id is the PK) and is a safe no-op if it's
    // already gone — unlike `delete({ where: { id } })`, which throws P2025 on a missing row (the same
    // reasoning as releaseRunLock's updateMany above).
    const result = await this.db.durableBufferedEvent.deleteMany({ where: { id } });
    return result.count === 1;
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
    awaitingDecisionTaskId: run.awaitingDecisionTaskId ?? null,
    recoveryAttempts: run.recoveryAttempts ?? null,
    tags: jsonOrNull(run.tags),
    searchAttributes: jsonOrNull(run.searchAttributes),
    priority: run.priority ?? null,
    // An absent namespace IS `'default'` — unlike `origin` below, this is a reconstruction and not a
    // guess: an engine started without a namespace stamps its runs and routes its workers as
    // `'default'`, so writing anything else (or NULL) would put the run in a partition no worker polls.
    namespace: run.namespace ?? 'default',
    // Absent origin stays SQL NULL — "unknown", never coerced into a real-looking library name.
    origin: run.origin ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function toRunPatch(patch: Partial<WorkflowRun>) {
  // Map EVERY patchable field, using presence (`'x' in patch`) semantics for the nullable ones so a
  // patch can CLEAR a column (e.g. `{ error: undefined }` on completion sets it to NULL — matching
  // the TypeORM / MikroORM / in-memory stores). The two non-null Date fields use a defined-guard
  // since they are never cleared. Previously only 7 fields were mapped, so `updateRun({ tags })` /
  // `{ lockedBy }` / clearing `error` silently no-opped on this adapter.
  const data: Record<string, unknown> = {};
  if ('workflow' in patch) data.workflow = patch.workflow;
  if ('workflowVersion' in patch) data.workflowVersion = patch.workflowVersion;
  if ('status' in patch) data.status = patch.status;
  if ('input' in patch) data.input = jsonOrNull(patch.input);
  if ('output' in patch) data.output = jsonOrNull(patch.output);
  if ('error' in patch) data.error = jsonOrNull(patch.error);
  if ('wakeAt' in patch) data.wakeAt = bigOrNull(patch.wakeAt);
  if ('lockedBy' in patch) data.lockedBy = patch.lockedBy ?? null;
  if ('lockedUntil' in patch)
    data.lockedUntil = patch.lockedUntil == null ? null : new Date(patch.lockedUntil);
  if ('awaitingDecisionTaskId' in patch)
    data.awaitingDecisionTaskId = patch.awaitingDecisionTaskId ?? null;
  if ('recoveryAttempts' in patch) data.recoveryAttempts = patch.recoveryAttempts ?? null;
  if ('tags' in patch) data.tags = jsonOrNull(patch.tags);
  if ('searchAttributes' in patch) data.searchAttributes = jsonOrNull(patch.searchAttributes);
  if ('priority' in patch) data.priority = patch.priority ?? null;
  // `?? 'default'` rather than `?? null` like its neighbours: the column is NOT NULL, and clearing a
  // run's namespace means "back to the unscoped partition", which is what `'default'` names. A patch
  // that does not mention `namespace` leaves the stored one alone — a status update must never move a
  // run between tenants.
  if ('namespace' in patch) data.namespace = patch.namespace ?? 'default';
  if ('origin' in patch) data.origin = patch.origin ?? null;
  if (patch.createdAt != null) data.createdAt = patch.createdAt;
  if (patch.updatedAt != null) data.updatedAt = patch.updatedAt;
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
    awaitingDecisionTaskId: row.awaitingDecisionTaskId ?? undefined,
    recoveryAttempts: row.recoveryAttempts ?? undefined,
    tags: (row.tags as string[] | null) ?? undefined,
    searchAttributes:
      (row.searchAttributes as Record<string, string | number | boolean> | null) ?? undefined,
    priority: row.priority ?? undefined,
    // Read back verbatim, with NO `?? 'default'` fallback. The column is NOT NULL and the migration
    // back-fills old rows, so there is nothing legitimate to fall back FROM; a fallback would only fire
    // on a deployment that added the column nullable without back-filling, and there it would lie —
    // the dashboard would show `default` for a row whose stored NULL keeps every `default` worker's
    // `WHERE namespace = 'default'` from ever picking it up.
    namespace: row.namespace,
    // NULL (a row written before the column existed) surfaces as `undefined` = unknown origin.
    origin: row.origin ?? undefined,
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
    parallelGroup: cp.parallelGroup ?? null,
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
    parallelGroup: row.parallelGroup ?? undefined,
    wakeAt: numOrUndef(row.wakeAt),
    enqueuedAt: row.enqueuedAt ?? row.startedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
