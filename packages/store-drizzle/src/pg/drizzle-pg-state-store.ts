import {
  type AttributeFilter,
  RUN_VALUE_FACET_SCAN,
  type RetentionPolicy,
  type RunFacetQuery,
  type RunFacetRow,
  type RunQuery,
  type RunStatus,
  type RunValueAxis,
  type RunValueFacetOptions,
  type RunValueFacetRow,
  type ScheduleQuery,
  type ScheduleRecord,
  type SignalWaiter,
  type StateStore,
  type StepCheckpoint,
  type StepError,
  type StepEvent,
  type StoreTransaction,
  TERMINAL_RUN_STATUSES,
  type WorkflowRun,
  attributePredicateOperands,
  axisIsRunColumn,
  mergeRunFacetRows,
  mergeRunValueFacetRows,
  normalizeAttributeRows,
  parseDuration,
  runValueFacetsFromRuns,
} from '@dudousxd/nestjs-durable-core';
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { ensureDrizzlePgDurableSchema } from './ddl';
import {
  DEFAULT_NAMESPACE,
  durableBufferedEvents as bufferedEvents,
  durableBufferedSignals as bufferedSignals,
  durableRunAttributes as runAttributes,
  durableSchedules as schedules,
  durableSignalWaiters as signalWaiters,
  durableStepCheckpoints as stepCheckpoints,
  durableWorkflowRuns as workflowRuns,
} from './schema';

type RunRow = typeof workflowRuns.$inferSelect;
type RunInsert = typeof workflowRuns.$inferInsert;
type CheckpointRow = typeof stepCheckpoints.$inferSelect;

/**
 * Any drizzle Postgres database — `drizzle-orm/node-postgres`, `drizzle-orm/postgres-js`,
 * `drizzle-orm/pglite`, Neon, … — built with or without a relational schema. The store only uses the
 * query builder (never `db.query.*`), so you do not have to register the durable tables on it.
 */
export type DrizzlePgDatabase = PgDatabase<any, any, any>;

export interface DrizzlePgStateStoreOptions {
  /**
   * Confine every RUN read (`getRun`, `listRuns`, facets, and the pending / incomplete / due-timer
   * polls) to one namespace — a tenant-boundary view of the store. Omit for the operator
   * (control-plane) view that sees every namespace. The NestJS module's `scopeReads` option applies
   * this for you via {@link DrizzlePgStateStore.withScope}.
   */
  scope?: { namespace?: string | undefined } | undefined;
}

/** OR a set of conditions where an EMPTY set means "matches nothing" (every plural `RunQuery`
 *  predicate's contract) — `or()` of nothing would be dropped by `and()` and match everything. */
function anyOf(conditions: (SQL | undefined)[]): SQL {
  const present = conditions.filter((c): c is SQL => c !== undefined);
  return present.length ? (or(...present) as SQL) : sql`1 = 0`;
}

/** `undefined` = no restriction (the operator view), never `namespace IS NULL`. The column is
 *  NOT NULL DEFAULT 'default', so plain equality is exact. */
function namespaceFilter(namespace: string | undefined): SQL | undefined {
  return namespace === undefined ? undefined : eq(workflowRuns.namespace, namespace);
}

/** `tags @> '["tag"]'::jsonb` — exact element containment (so `etl` never matches `etl-foo`), and
 *  served by the `durable_runs_tags_gin_idx` GIN (`jsonb_path_ops`) index. */
function hasTag(tag: string): SQL {
  return sql`${workflowRuns.tags} @> ${JSON.stringify([tag])}::jsonb`;
}

const date = (ms: number | undefined | null): Date | null => (ms == null ? null : new Date(ms));
const ms = (d: Date | null): number | undefined => (d == null ? undefined : d.getTime());

/**
 * Drizzle `StateStore` for **PostgreSQL**. Pass any drizzle Postgres db (see {@link DrizzlePgDatabase});
 * the durable tables come from `./schema` (drizzle-kit) or {@link ensureSchema} (auto-schema).
 *
 * Postgres-specific behaviour, beyond the shared contract:
 *  - leases (`tryLockRun` / `renewRunLock`) are a single conditional `UPDATE … RETURNING`, so two
 *    instances racing for the same run serialize on the row lock and exactly one wins;
 *  - `takeSignalWaiter` is one `DELETE … RETURNING` (atomic take), and `takeBufferedSignal` claims the
 *    oldest row with `FOR UPDATE SKIP LOCKED`, so concurrent takers each get a DIFFERENT signal
 *    instead of blocking or double-delivering;
 *  - `pruneTerminalRuns` (retention) selects its batch with `FOR UPDATE SKIP LOCKED`, so several
 *    pods sweeping at once split the backlog instead of contending on it;
 *  - tag filters are jsonb containment (GIN-indexed) and attribute filters push down as EXISTS
 *    probes on the indexed side table.
 */
export class DrizzlePgStateStore implements StateStore {
  private readonly scopeNamespace: string | undefined;

  constructor(
    private readonly db: DrizzlePgDatabase,
    private readonly options: DrizzlePgStateStoreOptions = {},
  ) {
    this.scopeNamespace = options.scope?.namespace;
  }

  /** A store confined to `scope.namespace`, sharing this store's db (no new connection). Used by the
   *  NestJS module's `scopeReads`; `{ namespace: undefined }` is the unscoped operator view. */
  withScope(scope: { namespace?: string | undefined }): DrizzlePgStateStore {
    return new DrizzlePgStateStore(this.db, { ...this.options, scope });
  }

  /** Idempotent CREATE TABLE / INDEX IF NOT EXISTS under an advisory lock — called on boot when the
   *  module's `autoSchema` is on. Turn `autoSchema` off if drizzle-kit owns these tables. */
  async ensureSchema(): Promise<void> {
    await ensureDrizzlePgDurableSchema(this.db);
  }

  /** The read-scope predicate on the runs table (undefined when the store is unscoped). */
  private scope(): SQL | undefined {
    return namespaceFilter(this.scopeNamespace);
  }

  async createRun(run: WorkflowRun): Promise<void> {
    // One transaction: a run is never visible without its attribute rows (or vice versa).
    await this.db.transaction(async (tx) => {
      await tx.insert(workflowRuns).values(toRunRow(run));
      await reindexAttributes(tx, run.id, run.searchAttributes);
    });
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const row = toRunPatch(patch);
    const reindex = 'searchAttributes' in patch;
    if (!Object.keys(row).length && !reindex) return;
    await this.db.transaction(async (tx) => {
      // Drizzle throws on `.set({})`; skip the UPDATE when no mapped column changed.
      if (Object.keys(row).length)
        await tx.update(workflowRuns).set(row).where(eq(workflowRuns.id, runId));
      if (reindex) await reindexAttributes(tx, runId, patch.searchAttributes);
    });
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), this.scope()))
      .limit(1);
    return rows[0] ? fromRunRow(rows[0]) : null;
  }

  async deleteRun(runId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await deleteRunsCascade(tx, [runId]);
    });
  }

  async deleteRuns(runIds: string[]): Promise<void> {
    if (runIds.length === 0) return;
    await this.db.transaction(async (tx) => {
      await deleteRunsCascade(tx, runIds);
    });
  }

  async pruneTerminalRuns(policy: RetentionPolicy, nowMs: number, limit: number): Promise<number> {
    // Only terminal statuses are ever eligible — a policy naming a live status would race the engine.
    const statuses = policy.statuses.filter((s) => TERMINAL_RUN_STATUSES.includes(s));
    if (statuses.length === 0 || limit <= 0) return 0;
    if (policy.maxAge == null && policy.maxCount == null) return 0;
    // A scoped policy only ever sees (and, for maxCount, counts) the runs its scope matches.
    const scoped = this.runFilters({ ...(policy.scope ?? {}), statuses });
    return this.db.transaction(async (tx) => {
      const ids = new Set<string>();
      if (policy.maxAge != null) {
        const cutoff = new Date(nowMs - parseDuration(policy.maxAge));
        const rows = await tx
          .select({ id: workflowRuns.id })
          .from(workflowRuns)
          .where(and(...scoped, lt(workflowRuns.updatedAt, cutoff)))
          .orderBy(asc(workflowRuns.updatedAt)) // oldest first
          .limit(limit)
          .for('update', { skipLocked: true });
        for (const r of rows) ids.add(r.id);
      }
      if (policy.maxCount != null && ids.size < limit) {
        // Everything past the newest `maxCount` rows of the status set. The kept window is skipped by
        // OFFSET (no row lock there), and only the rows past it are locked for deletion.
        const rows = await tx
          .select({ id: workflowRuns.id })
          .from(workflowRuns)
          .where(and(...scoped))
          .orderBy(desc(workflowRuns.updatedAt), desc(workflowRuns.id))
          .limit(limit)
          .offset(policy.maxCount)
          .for('update', { skipLocked: true });
        for (const r of rows) {
          if (ids.size >= limit) break;
          ids.add(r.id);
        }
      }
      if (ids.size === 0) return 0;
      const idList = [...ids].slice(0, limit);
      await deleteRunsCascade(tx, idList);
      return idList.length;
    });
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
    await upsertCheckpoint(this.db, checkpoint);
  }

  async transaction<T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      work({ raw: tx, saveCheckpoint: (cp) => upsertCheckpoint(tx, cp) }),
    );
  }

  /** Crash recovery. Namespace-scoped: a worker re-drives only its own tenant's runs. */
  async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          inArray(workflowRuns.status, ['running', 'cancelling']),
          namespaceFilter(namespace),
          this.scope(),
        ),
      );
    return rows.map(fromRunRow);
  }

  /** FIFO pick-up, served by `durable_workflow_runs_namespace_status_idx`. The engine then leases
   *  each run with {@link tryLockRun}; the listing itself takes no locks (it runs outside a tx). */
  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.status, 'pending'), namespaceFilter(namespace), this.scope()))
      .orderBy(asc(workflowRuns.createdAt))
      .limit(limit);
    return rows.map(fromRunRow);
  }

  async listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.status, 'suspended'),
          isNotNull(workflowRuns.wakeAt),
          lte(workflowRuns.wakeAt, new Date(nowMs)),
          namespaceFilter(namespace),
          this.scope(),
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
    // One conditional UPDATE: under READ COMMITTED a concurrent contender blocks on the row lock,
    // then re-evaluates the WHERE against the winner's committed row and matches nothing.
    const rows = await this.db
      .update(workflowRuns)
      .set({ lockedBy: owner, lockedUntil: new Date(leaseUntilMs) })
      .where(
        and(
          eq(workflowRuns.id, runId),
          or(isNull(workflowRuns.lockedUntil), lte(workflowRuns.lockedUntil, new Date(nowMs))),
        ),
      )
      .returning({ id: workflowRuns.id });
    return rows.length === 1;
  }

  async releaseRunLock(runId: string): Promise<void> {
    await this.db
      .update(workflowRuns)
      .set({ lockedBy: null, lockedUntil: null })
      .where(eq(workflowRuns.id, runId));
  }

  async renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    const rows = await this.db
      .update(workflowRuns)
      .set({ lockedUntil: new Date(leaseUntilMs) })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.lockedBy, owner)))
      .returning({ id: workflowRuns.id });
    return rows.length === 1;
  }

  /** The predicates every run query shares — {@link listRuns} pages them, the facets group them. */
  private runFilters(query: RunQuery): SQL[] {
    return [
      this.scope(),
      query.workflow ? eq(workflowRuns.workflow, query.workflow) : undefined,
      query.workflows
        ? query.workflows.length
          ? inArray(workflowRuns.workflow, query.workflows)
          : sql`1 = 0`
        : undefined,
      // The tenant boundary. Also the engine's execution-timeout sweep path
      // (`listRuns({ workflow, status, namespace })`) — unscoped, it would cancel another tenant's runs.
      namespaceFilter(query.namespace),
      query.namespaces
        ? query.namespaces.length
          ? inArray(workflowRuns.namespace, query.namespaces)
          : sql`1 = 0`
        : undefined,
      // `null` selects the unattributed bucket; a value never matches a NULL origin.
      query.origin === null
        ? isNull(workflowRuns.origin)
        : query.origin !== undefined
          ? eq(workflowRuns.origin, query.origin)
          : undefined,
      query.origins
        ? anyOf(
            query.origins.map((o) =>
              o === null ? isNull(workflowRuns.origin) : eq(workflowRuns.origin, o),
            ),
          )
        : undefined,
      query.status ? eq(workflowRuns.status, query.status) : undefined,
      query.statuses
        ? query.statuses.length
          ? inArray(workflowRuns.status, query.statuses)
          : sql`1 = 0`
        : undefined,
      query.tag ? hasTag(query.tag) : undefined,
      query.tags ? anyOf(query.tags.map(hasTag)) : undefined,
      // One EXISTS per attribute predicate against the normalized side table (ANDed).
      ...(query.attributes?.map((f) => this.attributeExists(f)) ?? []),
    ].filter((f): f is SQL => f !== undefined);
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const filters = this.runFilters(query);
    const base = this.db
      .select()
      .from(workflowRuns)
      .where(filters.length ? and(...filters) : undefined)
      // newest first; id breaks created_at ties so limit/offset pages are stable
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
      .$dynamic();
    if (query.limit != null) base.limit(query.limit);
    if (query.offset != null) base.offset(query.offset);
    const rows = await base;
    return rows.map(fromRunRow);
  }

  async countRuns(query: Omit<RunQuery, 'limit' | 'offset'>): Promise<number> {
    const filters = this.runFilters(query);
    const rows = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(workflowRuns)
      .where(filters.length ? and(...filters) : undefined);
    return rows[0]?.count ?? 0;
  }

  async runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    const filters = this.runFilters(query);
    const rows = await this.db
      .select({
        status: workflowRuns.status,
        origin: workflowRuns.origin,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(workflowRuns)
      .where(filters.length ? and(...filters) : undefined)
      .groupBy(workflowRuns.status, workflowRuns.origin);
    return mergeRunFacetRows(
      rows.map((r) => ({ status: r.status as RunStatus, origin: r.origin, count: r.count })),
    );
  }

  /** Run-table axes are an exact `GROUP BY`; the tag / attribute axes are counted over a bounded
   *  page of runs (see `RunValueFacetOptions.scan`), like the TypeORM and SQLite Drizzle adapters. */
  async runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    if (!axisIsRunColumn(axis)) {
      const runs = await this.listRuns({ ...query, limit: opts?.scan ?? RUN_VALUE_FACET_SCAN });
      return runValueFacetsFromRuns(runs, axis, opts);
    }
    const column = workflowRuns[axis.field];
    const filters = this.runFilters(query);
    const rows = await this.db
      .select({ value: column, count: sql<number>`count(*)`.mapWith(Number) })
      .from(workflowRuns)
      .where(filters.length ? and(...filters) : undefined)
      .groupBy(column);
    return mergeRunValueFacetRows(
      rows.map((r) => ({ value: (r.value as string | null) ?? null, count: r.count })),
      opts,
    );
  }

  /** One attribute predicate as an EXISTS on the side table, correlated to the outer run. `ne` also
   *  excludes runs lacking the key (EXISTS requires the row). Numbers compare `num_value`, strings
   *  and booleans `str_value`; an `in` set ORs its members inside the one EXISTS. */
  private attributeExists(f: AttributeFilter): SQL {
    const comparisons = attributePredicateOperands(f).map(
      ({ column, comparator, operand }) =>
        sql`${column === 'numValue' ? runAttributes.numValue : runAttributes.strValue} ${sql.raw(comparator)} ${operand}`,
    );
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(runAttributes)
        .where(
          and(
            eq(runAttributes.runId, workflowRuns.id),
            eq(runAttributes.key, f.key),
            anyOf(comparisons),
          ),
        ),
    );
  }

  // ---- persisted schedules ----------------------------------------------------------------------

  async saveSchedule(record: ScheduleRecord): Promise<void> {
    const row = toScheduleRow(record);
    await this.db
      .insert(schedules)
      .values(row)
      .onConflictDoUpdate({ target: schedules.id, set: row });
  }

  async getSchedule(id: string): Promise<ScheduleRecord | null> {
    const rows = await this.db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    return rows[0] ? fromScheduleRow(rows[0]) : null;
  }

  /** A single conditional `UPDATE … RETURNING`: the compare-and-set on `next_fire_at` is atomic. */
  async updateSchedule(
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt'>>,
    expectedNextFireAt?: number | null,
  ): Promise<boolean> {
    const set = toSchedulePatch(patch);
    if (!Object.keys(set).length) return (await this.getSchedule(id)) !== null;
    const rows = await this.db
      .update(schedules)
      .set(set)
      .where(
        and(
          eq(schedules.id, id),
          expectedNextFireAt === undefined
            ? undefined
            : expectedNextFireAt === null
              ? isNull(schedules.nextFireAt)
              : eq(schedules.nextFireAt, new Date(expectedNextFireAt)),
        ),
      )
      .returning({ id: schedules.id });
    return rows.length > 0;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(schedules)
      .where(eq(schedules.id, id))
      .returning({ id: schedules.id });
    return rows.length > 0;
  }

  async listSchedules(query: ScheduleQuery): Promise<ScheduleRecord[]> {
    const base = this.db
      .select()
      .from(schedules)
      .where(
        and(
          query.namespace !== undefined ? eq(schedules.namespace, query.namespace) : undefined,
          query.workflow !== undefined ? eq(schedules.workflow, query.workflow) : undefined,
          query.paused !== undefined ? eq(schedules.paused, query.paused) : undefined,
          query.tag !== undefined
            ? sql`${schedules.tags} @> ${JSON.stringify([query.tag])}::jsonb`
            : undefined,
          query.dueBy !== undefined
            ? and(eq(schedules.paused, false), lte(schedules.nextFireAt, new Date(query.dueBy)))
            : undefined,
        ),
      )
      // Soonest-due first, never-firing (NULL) last, id as the stable tie-break.
      .orderBy(sql`${schedules.nextFireAt} ASC NULLS LAST`, asc(schedules.id))
      .$dynamic();
    if (query.limit != null) base.limit(query.limit);
    if (query.offset != null) base.offset(query.offset);
    return (await base).map(fromScheduleRow);
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    const rows = await this.db
      .select()
      .from(stepCheckpoints)
      .where(eq(stepCheckpoints.runId, runId))
      .orderBy(asc(stepCheckpoints.seq));
    return rows.map(fromCheckpointRow);
  }

  async getLatestCheckpointByName(
    runId: string,
    name: string,
  ): Promise<StepCheckpoint | undefined> {
    const rows = await this.db
      .select()
      .from(stepCheckpoints)
      .where(and(eq(stepCheckpoints.runId, runId), eq(stepCheckpoints.name, name)))
      .orderBy(desc(stepCheckpoints.seq))
      .limit(1);
    return rows[0] ? fromCheckpointRow(rows[0]) : undefined;
  }

  async listCheckpointsByNamePrefix(runId: string, prefixes: string[]): Promise<StepCheckpoint[]> {
    if (prefixes.length === 0) return [];
    const rows = await this.db
      .select()
      .from(stepCheckpoints)
      .where(
        and(
          eq(stepCheckpoints.runId, runId),
          or(...prefixes.map((p) => like(stepCheckpoints.name, `${escapeLike(p)}%`))),
        ),
      )
      .orderBy(asc(stepCheckpoints.seq));
    return rows.map(fromCheckpointRow);
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    const set = {
      runId: waiter.runId,
      seq: waiter.seq,
      parallelGroup: waiter.parallelGroup ?? null,
    };
    await this.db
      .insert(signalWaiters)
      .values({ token: waiter.token, ...set })
      .onConflictDoUpdate({ target: signalWaiters.token, set });
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    // Atomic take: one DELETE … RETURNING, so two concurrent signals for the same token can never
    // both resume the run.
    const rows = await this.db
      .delete(signalWaiters)
      .where(eq(signalWaiters.token, token))
      .returning();
    const row = rows[0];
    return row ? fromWaiterRow(row) : null;
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    const rows = await this.db
      .select()
      .from(signalWaiters)
      .where(like(signalWaiters.token, `${escapeLike(prefix)}%`));
    return rows.map(fromWaiterRow);
  }

  async removeSignalWaiter(waiter: SignalWaiter): Promise<void> {
    // Exact match — never remove a row a DIFFERENT run has since claimed the token with.
    await this.db
      .delete(signalWaiters)
      .where(
        and(
          eq(signalWaiters.token, waiter.token),
          eq(signalWaiters.runId, waiter.runId),
          eq(signalWaiters.seq, waiter.seq),
        ),
      );
  }

  async bufferSignal(token: string, payload: unknown): Promise<void> {
    await this.db.insert(bufferedSignals).values({ token, payload: payload ?? null });
  }

  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    // Claim the oldest buffered signal for `token` with SKIP LOCKED and delete it in the same
    // statement: concurrent takers each get a different row (FIFO), none blocks, none double-reads.
    const oldest = this.db
      .select({ id: bufferedSignals.id })
      .from(bufferedSignals)
      .where(eq(bufferedSignals.token, token))
      .orderBy(asc(bufferedSignals.id))
      .limit(1)
      .for('update', { skipLocked: true });
    const rows = await this.db
      .delete(bufferedSignals)
      .where(inArray(bufferedSignals.id, oldest))
      .returning({ payload: bufferedSignals.payload });
    const row = rows[0];
    return row ? { payload: row.payload ?? undefined } : null;
  }

  async bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void> {
    await this.db.insert(bufferedEvents).values({
      id: input.id,
      name: input.name,
      payload: input.payload ?? null,
      publishedAt: new Date(input.publishedAt),
    });
  }

  async listBufferedEvents(
    name: string,
    limit: number,
  ): Promise<Array<{ id: string; payload: unknown; publishedAt: number }>> {
    const rows = await this.db
      .select()
      .from(bufferedEvents)
      .where(eq(bufferedEvents.name, name))
      .orderBy(asc(bufferedEvents.publishedAt), asc(bufferedEvents.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      payload: r.payload ?? undefined,
      publishedAt: r.publishedAt.getTime(),
    }));
  }

  async removeBufferedEvent(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(bufferedEvents)
      .where(eq(bufferedEvents.id, id))
      .returning({ id: bufferedEvents.id });
    return rows.length === 1;
  }
}

/** Escape LIKE metacharacters so a literal prefix (`event:50%_off`) matches only itself. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function upsertCheckpoint(db: DrizzlePgDatabase, cp: StepCheckpoint): Promise<void> {
  const row = toCheckpointRow(cp);
  await db
    .insert(stepCheckpoints)
    .values(row)
    .onConflictDoUpdate({ target: [stepCheckpoints.runId, stepCheckpoints.seq], set: row });
}

/** Rewrite a run's normalized attribute rows so the side table mirrors its live searchAttributes. */
async function reindexAttributes(
  db: DrizzlePgDatabase,
  runId: string,
  attributes: WorkflowRun['searchAttributes'],
): Promise<void> {
  await db.delete(runAttributes).where(eq(runAttributes.runId, runId));
  const rows = normalizeAttributeRows(runId, attributes);
  if (rows.length) await db.insert(runAttributes).values(rows);
}

/** Children first, then the runs — checkpoints, waiters, attribute rows. Call inside a tx. */
async function deleteRunsCascade(db: DrizzlePgDatabase, runIds: string[]): Promise<void> {
  await db.delete(stepCheckpoints).where(inArray(stepCheckpoints.runId, runIds));
  await db.delete(signalWaiters).where(inArray(signalWaiters.runId, runIds));
  await db.delete(runAttributes).where(inArray(runAttributes.runId, runIds));
  await db.delete(workflowRuns).where(inArray(workflowRuns.id, runIds));
}

function fromWaiterRow(row: typeof signalWaiters.$inferSelect): SignalWaiter {
  return {
    token: row.token,
    runId: row.runId,
    seq: row.seq,
    parallelGroup: row.parallelGroup ?? undefined,
  };
}

function toRunRow(run: WorkflowRun): RunInsert {
  return {
    id: run.id,
    workflow: run.workflow,
    workflowVersion: run.workflowVersion,
    status: run.status,
    input: run.input ?? null,
    output: run.output ?? null,
    error: run.error ?? null,
    wakeAt: date(run.wakeAt),
    lockedBy: run.lockedBy ?? null,
    lockedUntil: date(run.lockedUntil),
    awaitingDecisionTaskId: run.awaitingDecisionTaskId ?? null,
    recoveryAttempts: run.recoveryAttempts ?? null,
    tags: run.tags ?? null,
    searchAttributes: run.searchAttributes ?? null,
    priority: run.priority ?? null,
    namespace: run.namespace ?? DEFAULT_NAMESPACE,
    origin: run.origin ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/** Presence (`'x' in patch`) semantics, so a patch can CLEAR a nullable column (`{ error: undefined }`
 *  → NULL), matching the other adapters and the in-memory reference store. */
function toRunPatch(patch: Partial<WorkflowRun>): Partial<RunInsert> {
  const row: Partial<RunInsert> = {};
  if (patch.workflow !== undefined) row.workflow = patch.workflow;
  if (patch.workflowVersion !== undefined) row.workflowVersion = patch.workflowVersion;
  if (patch.status !== undefined) row.status = patch.status;
  if ('input' in patch) row.input = patch.input ?? null;
  if ('output' in patch) row.output = patch.output ?? null;
  if ('error' in patch) row.error = patch.error ?? null;
  if ('wakeAt' in patch) row.wakeAt = date(patch.wakeAt);
  if ('lockedBy' in patch) row.lockedBy = patch.lockedBy ?? null;
  if ('lockedUntil' in patch) row.lockedUntil = date(patch.lockedUntil);
  if ('awaitingDecisionTaskId' in patch)
    row.awaitingDecisionTaskId = patch.awaitingDecisionTaskId ?? null;
  if ('recoveryAttempts' in patch) row.recoveryAttempts = patch.recoveryAttempts ?? null;
  if ('tags' in patch) row.tags = patch.tags ?? null;
  if ('searchAttributes' in patch) row.searchAttributes = patch.searchAttributes ?? null;
  if ('priority' in patch) row.priority = patch.priority ?? null;
  // Never cleared to NULL: an undefined namespace means the default one.
  if ('namespace' in patch) row.namespace = patch.namespace ?? DEFAULT_NAMESPACE;
  if ('origin' in patch) row.origin = patch.origin ?? null;
  if (patch.createdAt != null) row.createdAt = patch.createdAt;
  if (patch.updatedAt != null) row.updatedAt = patch.updatedAt;
  return row;
}

function fromRunRow(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflow: row.workflow,
    workflowVersion: row.workflowVersion,
    status: row.status as RunStatus,
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    error: (row.error ?? undefined) as StepError | undefined,
    wakeAt: ms(row.wakeAt),
    lockedBy: row.lockedBy ?? undefined,
    lockedUntil: ms(row.lockedUntil),
    awaitingDecisionTaskId: row.awaitingDecisionTaskId ?? undefined,
    recoveryAttempts: row.recoveryAttempts ?? undefined,
    tags: row.tags ?? undefined,
    searchAttributes: row.searchAttributes ?? undefined,
    priority: row.priority ?? undefined,
    namespace: row.namespace,
    origin: row.origin ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
    parallelGroup: cp.parallelGroup ?? null,
    wakeAt: date(cp.wakeAt),
    enqueuedAt: cp.enqueuedAt ?? cp.startedAt,
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
    wakeAt: ms(row.wakeAt),
    // Older rows may lack enqueued_at; treat the start as enqueue time (queue-wait reads zero).
    enqueuedAt: row.enqueuedAt ?? row.startedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

type ScheduleRow = typeof schedules.$inferSelect;

function toScheduleRow(r: ScheduleRecord): ScheduleRow {
  return {
    id: r.id,
    namespace: r.namespace,
    workflow: r.workflow,
    paused: r.paused,
    nextFireAt: r.nextFireAt == null ? null : new Date(r.nextFireAt),
    tags: r.tags ?? null,
    spec: r.spec,
    state: r.state,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toSchedulePatch(
  patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt'>>,
): Partial<ScheduleRow> {
  const set: Partial<ScheduleRow> = {};
  if (patch.namespace !== undefined) set.namespace = patch.namespace;
  if (patch.workflow !== undefined) set.workflow = patch.workflow;
  if (patch.paused !== undefined) set.paused = patch.paused;
  if ('nextFireAt' in patch)
    set.nextFireAt = patch.nextFireAt == null ? null : new Date(patch.nextFireAt);
  if ('tags' in patch) set.tags = patch.tags ?? null;
  if (patch.spec !== undefined) set.spec = patch.spec;
  if (patch.state !== undefined) set.state = patch.state;
  if (patch.updatedAt !== undefined) set.updatedAt = patch.updatedAt;
  return set;
}

function fromScheduleRow(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    workflow: row.workflow,
    paused: row.paused,
    nextFireAt: row.nextFireAt ? row.nextFireAt.getTime() : null,
    ...(row.tags ? { tags: row.tags } : {}),
    spec: row.spec ?? {},
    state: row.state ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
