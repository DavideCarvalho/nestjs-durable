import {
  type AttributeFilter,
  type CheckpointNameKind,
  type CheckpointQuery,
  type CheckpointStat,
  type ChildWait,
  RUN_VALUE_FACET_SCAN,
  type RetentionPolicy,
  type RunFacetQuery,
  type RunFacetRow,
  type RunQuery,
  type RunStatus,
  type RunValueAxis,
  type RunValueFacetOptions,
  type RunValueFacetRow,
  SINGLETON_ACTIVE_STATUSES,
  type ScheduleQuery,
  type ScheduleRecord,
  type SignalWaiter,
  type StateStore,
  type StepCheckpoint,
  type StepError,
  type StepEvent,
  TERMINAL_RUN_STATUSES,
  type WorkflowRun,
  attributePredicateOperands,
  axisIsRunColumn,
  clearTerminalSingletonAdmission,
  mergeRunFacetRows,
  mergeRunValueFacetRows,
  normalizeAttributeRows,
  parseDuration,
  runValueFacetsFromRuns,
  singletonAdmissionDenialPatch,
  singletonAdmissionTags,
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
  count(args?: Args): Promise<number>;
  /** Aggregate form — used by the run facets and `checkpointStats`, whose rows are aggregate cells,
   *  not model rows, so the result type is stated at the call site rather than derived from `Row`. */
  groupBy(args: Args): Promise<Record<string, unknown>[]>;
}

interface ScheduleRow {
  id: string;
  namespace: string;
  workflow: string;
  paused: boolean;
  nextFireAt: bigint | null;
  tags: unknown;
  spec: unknown;
  state: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface DurablePrismaTx {
  durableWorkflowRun: Delegate<RunRow>;
  durableStepCheckpoint: Delegate<CheckpointRow>;
  durableRunAttribute: Delegate<RunAttributeRow>;
  durableSignalWaiter: Delegate<WaiterRow>;
  durableBufferedSignal: Delegate<BufferedSignalRow>;
  durableBufferedEvent: Delegate<BufferedEventRow>;
  /** Only needed for persisted schedules (`engine.schedules`) — add the `DurableSchedule` model. */
  durableSchedule?: Delegate<ScheduleRow>;
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

  async tryAdmitSingleton(
    runId: string,
    tag: string,
    workflow: string,
    limit: number,
    retryWakeAt?: number,
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const where = { workflow, status: { in: SINGLETON_ACTIVE_STATUSES } };
      // A locking write first: concurrent claims cannot read the same free slot.
      await tx.durableWorkflowRun.updateMany({ where, data: { workflow } });
      const rows = await tx.durableWorkflowRun.findMany({ where });
      const runs = rows.map(fromRunRow);
      const tags = singletonAdmissionTags(runs, runId, tag, workflow, limit);
      if (!tags) {
        const patch = singletonAdmissionDenialPatch(runs, runId, tag, workflow, retryWakeAt);
        if (patch)
          await tx.durableWorkflowRun.update({ where: { id: runId }, data: toRunPatch(patch) });
        return false;
      }
      await tx.durableWorkflowRun.update({ where: { id: runId }, data: { tags } });
      return true;
    });
  }

  async createRun(run: WorkflowRun): Promise<void> {
    await this.db.durableWorkflowRun.create({ data: toRunData(run) });
    await this.reindexAttributes(run.id, run.searchAttributes);
  }

  async updateRun(runId: string, inputPatch: Partial<WorkflowRun>): Promise<void> {
    const patch =
      inputPatch.status && TERMINAL_RUN_STATUSES.includes(inputPatch.status)
        ? await clearTerminalSingletonAdmission(runId, inputPatch, (id) => this.getRun(id))
        : inputPatch;
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

  async deleteRuns(runIds: string[]): Promise<void> {
    if (runIds.length === 0) return;
    // Same cascade as deleteRun, one `IN (...)` per table, atomically.
    await this.db.$transaction(async (tx) => {
      await tx.durableStepCheckpoint.deleteMany({ where: { runId: { in: runIds } } });
      await tx.durableSignalWaiter.deleteMany({ where: { runId: { in: runIds } } });
      await tx.durableRunAttribute.deleteMany({ where: { runId: { in: runIds } } });
      await tx.durableWorkflowRun.deleteMany({ where: { id: { in: runIds } } });
    });
  }

  async pruneTerminalRuns(policy: RetentionPolicy, nowMs: number, limit: number): Promise<number> {
    // Only terminal statuses are ever eligible — a policy naming a live status would race the engine.
    const statuses = policy.statuses.filter((s) => TERMINAL_RUN_STATUSES.includes(s));
    if (statuses.length === 0 || limit <= 0) return 0;
    if (policy.maxAge == null && policy.maxCount == null) return 0;
    // A scoped policy only ever sees (and, for maxCount, counts) the runs its scope matches.
    const scoped = this.runWhere({ ...(policy.scope ?? {}), statuses });
    const ids = new Set<string>();
    if (policy.maxAge != null) {
      const cutoff = new Date(nowMs - parseDuration(policy.maxAge));
      const rows = await this.db.durableWorkflowRun.findMany({
        where: { AND: [scoped, { updatedAt: { lt: cutoff } }] },
        select: { id: true },
        orderBy: { updatedAt: 'asc' }, // oldest first
        take: limit,
      });
      for (const r of rows) ids.add(r.id);
    }
    if (policy.maxCount != null && ids.size < limit) {
      // Everything past the newest `maxCount` rows of the scoped status set (skipped by OFFSET).
      const rows = await this.db.durableWorkflowRun.findMany({
        where: scoped,
        select: { id: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: policy.maxCount,
        take: limit,
      });
      for (const r of rows) {
        if (ids.size >= limit) break;
        ids.add(r.id);
      }
    }
    const doomed = [...ids].slice(0, limit);
    await this.deleteRuns(doomed);
    return doomed.length;
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

  async saveCheckpointIfPending(checkpoint: StepCheckpoint): Promise<boolean> {
    // One conditional `updateMany` (`UPDATE … WHERE run_id = ? AND seq = ? AND status = 'pending'`):
    // the status predicate is the compare, the row count the answer, and a missing row is never made.
    const { runId, seq, ...data } = toCheckpointData(checkpoint);
    const { count } = await this.db.durableStepCheckpoint.updateMany({
      where: { runId, seq, status: 'pending' },
      data,
    });
    return count > 0;
  }

  async saveCheckpointsIfPending(checkpoints: StepCheckpoint[]): Promise<boolean[]> {
    if (checkpoints.length === 0) return [];
    // The conditional `updateMany` of `saveCheckpointIfPending`, once per entry, in order, in one
    // transaction: one commit for the batch, and a rejection writes nothing.
    return this.db.$transaction(async (tx) => {
      const wrote: boolean[] = [];
      for (const checkpoint of checkpoints) {
        const { runId, seq, ...data } = toCheckpointData(checkpoint);
        const { count } = await tx.durableStepCheckpoint.updateMany({
          where: { runId, seq, status: 'pending' },
          data,
        });
        wrote.push(count > 0);
      }
      return wrote;
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

  async listDueTimers(nowMs: number, namespace?: string, limit?: number): Promise<WorkflowRun[]> {
    const rows = await this.db.durableWorkflowRun.findMany({
      where: {
        status: 'suspended',
        wakeAt: { not: null, lte: BigInt(nowMs) },
        ...namespaceWhere(namespace),
      },
      orderBy: { wakeAt: 'asc' },
      ...(limit !== undefined ? { take: limit } : {}),
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

  /** The `where` every run query shares — {@link listRuns} pages it, {@link runFacets} groups it. */
  private runWhere(query: RunQuery): Record<string, unknown> {
    // The tenant boundary, and NOT only a dashboard facet: the engine's `sweepTimeouts` finds the runs
    // it may cancel through `listRuns({ workflow, status, namespace })`, so an unfiltered `namespace`
    // here lets a worker serving one tenant time out another tenant's runs — a write, not a stale
    // read. Same `undefined` = no restriction rule as the poll paths above (see `namespaceWhere`),
    // which is what keeps the operator's dashboard showing every tenant by default.
    const where: Record<string, unknown> = { ...namespaceWhere(query.namespace) };
    // The plural predicates below can't sit on `where` directly (a key holds one condition, and the
    // single form may already own it), so they accumulate here and are ANDed at the end. Each is ORed
    // within itself and matches NOTHING when empty — the contract `statuses` already had.
    const and: Record<string, unknown>[] = [];
    if (query.workflow) where.workflow = query.workflow;
    if (query.workflows) and.push(anyOf(query.workflows.map((w) => ({ workflow: w }))));
    if (query.namespaces) and.push(anyOf(query.namespaces.map((n) => ({ namespace: n }))));
    // Which library registered the workflow. Plain equality, so a run whose origin is NULL (created
    // before the column existed, or registered through a path the derivation could not classify)
    // matches NO origin value — it is never folded into a bucket to make the facet look complete.
    // Unknown-origin runs are reachable only with the filter OFF, so "all origins" must stay the
    // default view; a dashboard that filtered by default would make those runs look deleted.
    // Passing `null` asks for exactly the unattributed bucket (`origin IS NULL`) — Prisma spells that
    // as the same equality — which is how a paginated console can offer an "unknown" chip.
    if (query.origin !== undefined) where.origin = query.origin;
    // `null` is a member like any other in a set of origins — Prisma spells `origin IS NULL` as the
    // same equality — so one branch per value covers both the named ones and the unattributed bucket.
    if (query.origins) and.push(anyOf(query.origins.map((o) => ({ origin: o }))));
    // `status IN (...)`; an empty set matches nothing (mirrors the in-memory store). Combined with the
    // single-value `status` via AND when both are present, so the narrower set wins.
    if (query.status && query.statuses) {
      and.push({ status: query.status }, { status: { in: query.statuses } });
    } else if (query.status) {
      where.status = query.status;
    } else if (query.statuses) {
      where.status = { in: query.statuses };
    }
    if (query.tag) where.tags = { array_contains: query.tag };
    if (query.tags) and.push(anyOf(query.tags.map((t) => ({ tags: { array_contains: t } }))));
    // Typed/range attribute predicates push DOWN into SQL: each filter becomes a relation `some`
    // (EXISTS) on the normalized `durable_run_attributes` side-table, so the DB filters AND paginates
    // — no full scan + in-process filter. ANDed: a run must match every filter, so one `some` each.
    if (query.attributes?.length) and.push(...query.attributes.map((f) => attributeSome(f)));
    if (and.length) where.AND = and;
    return where;
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const orderBy = { createdAt: 'desc' as const }; // newest first — recent runs on top in the dashboard
    const rows = await this.db.durableWorkflowRun.findMany({
      where: this.runWhere(query),
      take: query.limit,
      skip: query.offset,
      orderBy,
    });
    return rows.map(fromRunRow);
  }

  async countRuns(query: Omit<RunQuery, 'limit' | 'offset'>): Promise<number> {
    return this.db.durableWorkflowRun.count({ where: this.runWhere(query) });
  }

  /** `GROUP BY status, origin` over the same predicates {@link listRuns} pages — one aggregate, so a
   *  console can show whole-set counts next to a bounded page instead of downloading every run to
   *  count them in the browser. */
  async runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    const rows = (await this.db.durableWorkflowRun.groupBy({
      by: ['status', 'origin'],
      where: this.runWhere(query),
      _count: { _all: true },
    })) as { status: RunStatus; origin: string | null; _count: { _all: number } }[];
    return mergeRunFacetRows(
      rows.map((r) => ({ status: r.status, origin: r.origin, count: r._count._all })),
    );
  }

  /** Distinct values of one filter axis over the same predicates {@link listRuns} pages. A run-table
   *  column is a `groupBy` like {@link runFacets}, exact over the whole matching set; the tag and
   *  attribute axes live outside the row (json column / side table) and are counted from a bounded
   *  page of runs instead — see `RunValueFacetOptions.scan`. */
  async runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    if (!axisIsRunColumn(axis)) {
      const runs = await this.listRuns({ ...query, limit: opts?.scan ?? RUN_VALUE_FACET_SCAN });
      return runValueFacetsFromRuns(runs, axis, opts);
    }
    const rows = (await this.db.durableWorkflowRun.groupBy({
      by: [axis.field],
      where: this.runWhere(query),
      _count: { _all: true },
    })) as (Record<string, string | null> & { _count: { _all: number } })[];
    return mergeRunValueFacetRows(
      rows.map((r) => ({ value: r[axis.field] ?? null, count: r._count._all })),
      opts,
    );
  }

  // ---- persisted schedules ----------------------------------------------------------------------

  private schedules(): Delegate<ScheduleRow> {
    const delegate = this.db.durableSchedule;
    if (!delegate) {
      throw new Error(
        'persisted schedules need the DurableSchedule model — copy it from prisma/schema.prisma into your schema and re-run `prisma generate`',
      );
    }
    return delegate;
  }

  async saveSchedule(record: ScheduleRecord): Promise<void> {
    const data = toScheduleData(record);
    await this.schedules().upsert({ where: { id: record.id }, create: data, update: data });
  }

  async getSchedule(id: string): Promise<ScheduleRecord | null> {
    const row = await this.schedules().findUnique({ where: { id } });
    return row ? fromScheduleRow(row) : null;
  }

  /** One conditional `updateMany`: the compare-and-set on `next_fire_at` is a single statement. */
  async updateSchedule(
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt'>>,
    expectedNextFireAt?: number | null,
  ): Promise<boolean> {
    const data: Record<string, unknown> = {};
    if (patch.namespace !== undefined) data.namespace = patch.namespace;
    if (patch.workflow !== undefined) data.workflow = patch.workflow;
    if (patch.paused !== undefined) data.paused = patch.paused;
    if ('nextFireAt' in patch)
      data.nextFireAt = patch.nextFireAt == null ? null : BigInt(patch.nextFireAt);
    if ('tags' in patch) data.tags = jsonOrNull(patch.tags);
    if (patch.spec !== undefined) data.spec = patch.spec;
    if (patch.state !== undefined) data.state = patch.state;
    if (patch.updatedAt !== undefined) data.updatedAt = patch.updatedAt;
    if (!Object.keys(data).length) return (await this.getSchedule(id)) !== null;
    const where: Record<string, unknown> = { id };
    if (expectedNextFireAt !== undefined)
      where.nextFireAt = expectedNextFireAt === null ? null : BigInt(expectedNextFireAt);
    const { count } = await this.schedules().updateMany({ where, data });
    return count > 0;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const { count } = await this.schedules().deleteMany({ where: { id } });
    return count > 0;
  }

  async listSchedules(query: ScheduleQuery): Promise<ScheduleRecord[]> {
    const where: Record<string, unknown> = {};
    if (query.namespace !== undefined) where.namespace = query.namespace;
    if (query.workflow !== undefined) where.workflow = query.workflow;
    if (query.paused !== undefined) where.paused = query.paused;
    if (query.tag !== undefined) where.tags = { array_contains: query.tag };
    if (query.dueBy !== undefined) {
      where.AND = [{ paused: false }, { nextFireAt: { lte: BigInt(query.dueBy) } }];
    }
    const rows = await this.schedules().findMany({
      where,
      // Soonest-due first, never-firing (NULL) last, id as the stable tie-break.
      orderBy: [{ nextFireAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: query.limit,
      skip: query.offset,
    });
    return rows.map(fromScheduleRow);
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

  async countCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    statuses: StepCheckpoint['status'][],
  ): Promise<number> {
    if (statuses.length === 0) return 0;
    return this.db.durableStepCheckpoint.count({
      where: { runId, seq: { gte: fromSeq, lte: toSeq }, status: { in: statuses } },
    });
  }

  async listCheckpointsByNamePrefix(runId: string, prefixes: string[]): Promise<StepCheckpoint[]> {
    if (prefixes.length === 0) return [];
    const rows = await this.db.durableStepCheckpoint.findMany({
      where: { runId, OR: prefixes.map((p) => ({ name: { startsWith: p } })) },
      orderBy: { seq: 'asc' },
    });
    // On some providers (SQLite) `startsWith` compiles to a `LIKE` that reads `_` and `%` as wildcards,
    // so it can match more than the prefix: keep only the exact matches.
    return rows.filter((r) => prefixes.some((p) => r.name.startsWith(p))).map(fromCheckpointRow);
  }

  /**
   * One `groupBy(parallelGroup, status)` per {@link CheckpointNameKind}, each narrowed to its kind by
   * a name-prefix predicate, run concurrently — Prisma cannot group by a `CASE`, so the kind is the
   * `where` instead. `minEnqueuedAt` reads a NULL `enqueuedAt` as `startedAt` (as
   * {@link fromCheckpointRow} does): a bucket whose non-null `enqueuedAt` count falls short of its
   * row count has such rows, and only for those kinds is the NULL subset's `min(startedAt)` asked for.
   *
   * On SQLite `startsWith` is a case-insensitive `LIKE`, as in {@link listCheckpointsByNamePrefix};
   * the kind prefixes are lower-case and wildcard-free, so only a step whose name starts with one of
   * them in another case would be classified differently there.
   */
  async checkpointStats(
    runId: string,
    opts?: { group?: string | undefined },
  ): Promise<CheckpointStat[]> {
    const scope = opts?.group === undefined ? { runId } : { runId, parallelGroup: opts.group };
    const grouped = await Promise.all(
      NAME_KINDS.map(async ({ kind, where }) => ({
        kind,
        where,
        rows: (await this.db.durableStepCheckpoint.groupBy({
          by: ['parallelGroup', 'status'],
          where: { ...scope, ...where },
          _count: { _all: true, enqueuedAt: true },
          _min: { seq: true, name: true, enqueuedAt: true, startedAt: true },
          _max: { seq: true, name: true, startedAt: true, finishedAt: true },
          _sum: { attempts: true },
        })) as CheckpointStatRow[],
      })),
    );
    const stats = await Promise.all(
      grouped.map(async ({ kind, where, rows }) => {
        const unenqueued = rows.some((r) => r._count.enqueuedAt < r._count._all)
          ? await this.unenqueuedStartedAt({ ...scope, ...where })
          : new Map<string, Date>();
        return rows.map((r) => toCheckpointStat(kind, r, unenqueued));
      }),
    );
    return stats.flat();
  }

  /** `min(startedAt)` per `(parallelGroup, status)` over the rows whose `enqueuedAt` is NULL. */
  private async unenqueuedStartedAt(where: Record<string, unknown>): Promise<Map<string, Date>> {
    const rows = (await this.db.durableStepCheckpoint.groupBy({
      by: ['parallelGroup', 'status'],
      where: { ...where, enqueuedAt: null },
      _min: { startedAt: true },
    })) as { parallelGroup: string | null; status: string; _min: { startedAt: Date } }[];
    return new Map(rows.map((r) => [bucketKey(r.parallelGroup, r.status), r._min.startedAt]));
  }

  /** {@link CheckpointQuery} as one `findMany`, in `seq` order, paged by `skip`/`take`. Ungrouped rows
   *  are kept past `excludeGroups` explicitly: `NOT IN` alone drops a NULL `parallelGroup`. */
  async queryCheckpoints(runId: string, query: CheckpointQuery): Promise<StepCheckpoint[]> {
    if (query.statuses?.length === 0 || query.namePrefixes?.length === 0) return [];
    const and: Record<string, unknown>[] = [];
    if (query.excludeGroups?.length) {
      and.push({
        OR: [{ parallelGroup: null }, { parallelGroup: { notIn: query.excludeGroups } }],
      });
    }
    if (query.namePrefixes) {
      and.push({ OR: query.namePrefixes.map((p) => ({ name: { startsWith: p } })) });
    }
    const rows = await this.db.durableStepCheckpoint.findMany({
      where: {
        runId,
        ...(query.group === undefined ? {} : { parallelGroup: query.group }),
        ...(query.statuses ? { status: { in: query.statuses } } : {}),
        ...(and.length ? { AND: and } : {}),
      },
      orderBy: { seq: 'asc' },
      skip: query.offset,
      take: query.limit,
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
    // On some providers (SQLite) `startsWith` compiles to a `LIKE` that reads `_` and `%` as wildcards,
    // so it can match more than the prefix: keep only the exact matches.
    return rows
      .filter((r) => r.token.startsWith(prefix))
      .map((r) => ({
        token: r.token,
        runId: r.runId,
        seq: r.seq,
        parallelGroup: r.parallelGroup ?? undefined,
      }));
  }

  async registerChildWaits(entries: ChildWait[]): Promise<void> {
    if (entries.length === 0) return;
    // Prisma has no multi-row upsert: one upsert per row, inside a single transaction.
    await this.db.$transaction(async (tx) => {
      for (const { waiter } of entries) {
        const data = {
          runId: waiter.runId,
          seq: waiter.seq,
          parallelGroup: waiter.parallelGroup ?? null,
        };
        await tx.durableSignalWaiter.upsert({
          where: { token: waiter.token },
          create: { token: waiter.token, ...data },
          update: data,
        });
      }
      for (const { checkpoint } of entries) {
        const data = toCheckpointData(checkpoint);
        await tx.durableStepCheckpoint.upsert({
          where: { runId_seq: { runId: checkpoint.runId, seq: checkpoint.seq } },
          create: data,
          update: data,
        });
      }
    });
  }

  async compactCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    into: StepCheckpoint,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.durableStepCheckpoint.deleteMany({
        where: { runId, seq: { gte: fromSeq, lte: toSeq } },
      });
      const data = toCheckpointData(into);
      await tx.durableStepCheckpoint.upsert({
        where: { runId_seq: { runId: into.runId, seq: into.seq } },
        create: data,
        update: data,
      });
    });
  }

  async listSignalWaitersByRun(runIds: string[]): Promise<SignalWaiter[]> {
    if (runIds.length === 0) return [];
    const rows = await this.db.durableSignalWaiter.findMany({ where: { runId: { in: runIds } } });
    return rows.map((r) => ({
      token: r.token,
      runId: r.runId,
      seq: r.seq,
      parallelGroup: r.parallelGroup ?? undefined,
    }));
  }

  async hasSignalWaiter(runId: string, tokenPrefix: string): Promise<boolean> {
    // On SQLite, Prisma's `startsWith` is a bare `LIKE`: `_`/`%` in the prefix act as wildcards and
    // case is ignored. So a hit is confirmed in JS; only a pattern match that is not a real prefix
    // match pays for the full read.
    const where = { runId, token: { startsWith: tokenPrefix } };
    const first = await this.db.durableSignalWaiter.findFirst({ where, select: { token: true } });
    if (!first) return false;
    if (first.token.startsWith(tokenPrefix)) return true;
    const rows = await this.db.durableSignalWaiter.findMany({ where, select: { token: true } });
    return rows.some((r) => r.token.startsWith(tokenPrefix));
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
function attributeSome(f: AttributeFilter): Record<string, unknown> {
  // One comparison for a scalar op, one per member for `in` — ORed inside the single `some`, since
  // `in`'s operands may be of mixed types and so land in different typed columns. No comparisons at
  // all (an `in` over no values) can match no run, which is a run-level fact, not a side-table one.
  const comparisons = attributePredicateOperands(f).map(({ column, comparator, operand }) => ({
    [column]:
      comparator === '=' ? operand : comparator === '<>' ? { not: operand } : { [f.op]: operand },
  }));
  if (comparisons.length === 0) return MATCHES_NOTHING;
  return { attributes: { some: { key: f.key, ...anyOf(comparisons) } } };
}

/** A where fragment no run satisfies — what a plural predicate over an EMPTY set means. Spelled as an
 *  impossible `id` rather than `OR: []` so it does not depend on how a Prisma version reads an empty
 *  disjunction. */
const MATCHES_NOTHING: Record<string, unknown> = { id: { in: [] as string[] } };

/** OR a set of where fragments, where an EMPTY set matches nothing rather than everything. */
function anyOf(branches: Record<string, unknown>[]): Record<string, unknown> {
  return branches.length ? { OR: branches } : MATCHES_NOTHING;
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

/** The name prefix each non-`step` {@link CheckpointNameKind} is, as `checkpointNameKind` reads it. */
const KIND_PREFIXES: [CheckpointNameKind, string][] = [
  ['child', 'signal:child:'],
  ['folded', 'fan:'],
  ['spawn', 'spawn:'],
];

/** Each {@link CheckpointNameKind} as the `where` that selects its rows; `step` is "none of the others". */
const NAME_KINDS: { kind: CheckpointNameKind; where: Record<string, unknown> }[] = [
  ...KIND_PREFIXES.map(([kind, prefix]) => ({ kind, where: { name: { startsWith: prefix } } })),
  {
    kind: 'step',
    where: { NOT: KIND_PREFIXES.map(([, prefix]) => ({ name: { startsWith: prefix } })) },
  },
];

/** One `groupBy` row of {@link PrismaStateStore.checkpointStats}. */
type CheckpointStatRow = {
  parallelGroup: string | null;
  status: string;
  _count: { _all: number; enqueuedAt: number };
  _min: { seq: number; name: string; enqueuedAt: Date | null; startedAt: Date };
  _max: { seq: number; name: string; startedAt: Date; finishedAt: Date };
  _sum: { attempts: number | bigint | null };
};

function bucketKey(group: string | null, status: string): string {
  return JSON.stringify([group, status]);
}

function toCheckpointStat(
  nameKind: CheckpointNameKind,
  r: CheckpointStatRow,
  unenqueued: Map<string, Date>,
): CheckpointStat {
  const fallback = unenqueued.get(bucketKey(r.parallelGroup, r.status));
  const enqueued = r._min.enqueuedAt;
  const minEnqueuedAt =
    enqueued && fallback ? (enqueued < fallback ? enqueued : fallback) : (enqueued ?? fallback);
  return {
    group: r.parallelGroup,
    status: r.status as StepCheckpoint['status'],
    nameKind,
    count: r._count._all,
    minSeq: r._min.seq,
    maxSeq: r._max.seq,
    minName: r._min.name,
    maxName: r._max.name,
    // Every row has `enqueuedAt` or is in the NULL subset, so one of the two is set.
    minEnqueuedAt: minEnqueuedAt as Date,
    minStartedAt: r._min.startedAt,
    maxStartedAt: r._max.startedAt,
    maxFinishedAt: r._max.finishedAt,
    sumAttempts: Number(r._sum.attempts ?? 0),
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

function toScheduleData(r: ScheduleRecord) {
  return {
    id: r.id,
    namespace: r.namespace,
    workflow: r.workflow,
    paused: r.paused,
    nextFireAt: r.nextFireAt == null ? null : BigInt(r.nextFireAt),
    tags: jsonOrNull(r.tags),
    spec: r.spec,
    state: r.state,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function fromScheduleRow(row: ScheduleRow): ScheduleRecord {
  const tags = Array.isArray(row.tags) ? (row.tags as string[]) : undefined;
  return {
    id: row.id,
    namespace: row.namespace,
    workflow: row.workflow,
    paused: row.paused,
    nextFireAt: row.nextFireAt == null ? null : Number(row.nextFireAt),
    ...(tags?.length ? { tags } : {}),
    spec: (row.spec ?? {}) as Record<string, unknown>,
    state: (row.state ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
