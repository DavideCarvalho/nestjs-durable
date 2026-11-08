import {
  type AttributeFilter,
  type BufferedSignalRow,
  type CheckpointNameKind,
  type CheckpointQuery,
  type CheckpointStat,
  type ChildWait,
  LIFECYCLE_REGISTRY_WORKFLOW,
  type OwnedLeaseReclaim,
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
  type StepResultSettlement,
  type StepSettlement,
  type StoreTransaction,
  TERMINAL_RUN_STATUSES,
  type WorkflowRun,
  attributePredicateOperands,
  axisIsRunColumn,
  clearTerminalSingletonAdmission,
  mergeRunFacetRows,
  mergeRunValueFacetRows,
  normalizeAttributeRows,
  parseDuration,
  retentionKeeps,
  runValueFacetsFromRuns,
  singletonAdmissionDenialPatch,
  singletonAdmissionTags,
} from '@dudousxd/nestjs-durable-core';
import {
  type SQL,
  type Table,
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  getTableName,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { type DurableSchemaLogger, ensureDrizzlePgDurableSchema } from './ddl';
import { rowsOf } from './executor';
import { PgHotPath, type PgHotPathOptions, TableCodec, placeholders, quote } from './hot-path';
import {
  DEFAULT_NAMESPACE,
  durableBufferedEvents as bufferedEvents,
  durableBufferedSignals as bufferedSignals,
  durableRunAttributes as runAttributes,
  durableSchedules as schedules,
  durableSignalIds as signalIds,
  durableSignalWaiters as signalWaiters,
  durableStepCheckpoints as stepCheckpoints,
  durableWorkflowRuns as workflowRuns,
} from './schema';

/**
 * Workflows a retention policy never sees: lifecycle registry runs are neither pruned nor counted
 * toward `maxCount`.
 */
const RETENTION_EXCLUDED = [LIFECYCLE_REGISTRY_WORKFLOW];

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
  /**
   * Where `ensureSchema()` (the boot-time auto-schema) reports a schema repair it actually applied
   * — a missing table or index it had to create. Defaults to `console`. NestJS's `Logger`
   * satisfies it.
   */
  schemaLogger?: DurableSchemaLogger | undefined;
  /**
   * On node-postgres, send the statements every workflow turn and step result run as NAMED prepared
   * statements, parsed once per connection (see `PgHotPathOptions`). Needs a direct connection or
   * a pooler with protocol-level prepared statements; pass `false` behind PgBouncer in transaction
   * mode before 1.21. Default on.
   */
  preparedStatements?: PgHotPathOptions['preparedStatements'];
}

/** OR a set of conditions where an EMPTY set means "matches nothing" (every plural `RunQuery`
 *  predicate's contract) — `or()` of nothing would be dropped by `and()` and match everything. */
function anyOf(conditions: (SQL | undefined)[]): SQL {
  const present = conditions.filter((c): c is SQL => c !== undefined);
  return present.length ? (or(...present) as SQL) : sql`1 = 0`;
}

/** `undefined` = no restriction (the operator view), never `namespace IS NULL`. The column is
 *  NOT NULL DEFAULT 'default', so plain equality is exact — except that the default pool also
 *  matches legacy `''` rows (an engine configured with `namespace: ''` before '' was normalised). */
function namespaceFilter(namespace: string | undefined): SQL | undefined {
  if (namespace === undefined) return undefined;
  if (namespace === DEFAULT_NAMESPACE || namespace === '') {
    return inArray(workflowRuns.namespace, [DEFAULT_NAMESPACE, '']);
  }
  return eq(workflowRuns.namespace, namespace);
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
  /** Constant-SQL path for the per-step statements, on node-postgres (see `hot-path.ts`). */
  private readonly hot: PgHotPath | undefined;
  /** The run read-scope predicate as SQL text from `$2` on, and its values (hot path). */
  private readonly hotScope: { text: string; values: unknown[] };
  /** Hot-path UPDATE texts by patch shape. */
  private readonly hotUpdates = new Map<string, string>();

  constructor(
    private readonly db: DrizzlePgDatabase,
    private readonly options: DrizzlePgStateStoreOptions = {},
  ) {
    this.scopeNamespace = options.scope?.namespace;
    this.hot = PgHotPath.for(db, { preparedStatements: options.preparedStatements });
    const ns = this.scopeNamespace;
    this.hotScope =
      ns === undefined
        ? { text: '', values: [] }
        : ns === DEFAULT_NAMESPACE || ns === ''
          ? { text: ' AND "namespace" IN ($2, $3)', values: [DEFAULT_NAMESPACE, ''] }
          : { text: ' AND "namespace" = $2', values: [ns] };
  }

  /**
   * A hot-path `UPDATE` of the runs table setting `row`'s columns on run `$n`, optionally only while
   * its status is one of `expected` (then `RETURNING "id"`). Text cached per shape.
   */
  private hotRunUpdate(
    runId: string,
    row: Partial<RunInsert>,
    expected?: RunStatus[],
  ): { text: string; values: unknown[] } {
    const keys = Object.keys(row);
    const shape = `${keys.join(',')}|${expected?.length ?? -1}`;
    let text = this.hotUpdates.get(shape);
    if (text === undefined) {
      const set = keys.map((key, i) => `${RUNS.name(key)} = $${i + 1}`).join(', ');
      const id = keys.length + 1;
      text = `UPDATE ${T_RUNS} SET ${set} WHERE "id" = $${id}`;
      if (expected) {
        text += ` AND "status" IN (${placeholders(id + 1, expected.length)}) RETURNING "id"`;
      }
      this.hotUpdates.set(shape, text);
    }
    const values = keys.map((key) => RUNS.encode(key, (row as Record<string, unknown>)[key]));
    values.push(runId, ...(expected ?? []));
    return { text, values };
  }

  /** A store confined to `scope.namespace`, sharing this store's db (no new connection). Used by the
   *  NestJS module's `scopeReads`; `{ namespace: undefined }` is the unscoped operator view. */
  withScope(scope: { namespace?: string | undefined }): DrizzlePgStateStore {
    return new DrizzlePgStateStore(this.db, { ...this.options, scope });
  }

  /** Idempotent CREATE TABLE / INDEX IF NOT EXISTS under an advisory lock — called on boot when the
   *  module's `autoSchema` is on. Turn `autoSchema` off if drizzle-kit owns these tables. */
  async ensureSchema(): Promise<void> {
    await ensureDrizzlePgDurableSchema(this.db, { logger: this.options.schemaLogger });
  }

  /** The read-scope predicate on the runs table (undefined when the store is unscoped). */
  private scope(): SQL | undefined {
    return namespaceFilter(this.scopeNamespace);
  }

  async tryAdmitSingleton(
    runId: string,
    tag: string,
    workflow: string,
    limit: number,
    retryWakeAt?: number,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const where = and(
        eq(workflowRuns.workflow, workflow),
        inArray(workflowRuns.status, SINGLETON_ACTIVE_STATUSES),
        hasTag(tag),
        this.scope(),
      );
      // Lock only this key's runs, in one global order, so claims queue instead of deadlocking and
      // other keys never wait. The read below takes its snapshot once these locks are held.
      await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(where)
        .orderBy(asc(workflowRuns.id))
        .for('update');
      const rows = await tx.select().from(workflowRuns).where(where);
      const runs = rows.map(fromRunRow);
      const tags = singletonAdmissionTags(runs, runId, tag, workflow, limit);
      if (!tags) {
        const patch = singletonAdmissionDenialPatch(runs, runId, tag, workflow, retryWakeAt);
        if (patch)
          await tx.update(workflowRuns).set(toRunPatch(patch)).where(eq(workflowRuns.id, runId));
        return false;
      }
      await tx.update(workflowRuns).set({ tags }).where(eq(workflowRuns.id, runId));
      return true;
    });
  }

  async createRun(run: WorkflowRun): Promise<void> {
    if (normalizeAttributeRows(run.id, run.searchAttributes).length === 0) {
      // Nothing to index: the insert, then clear any attribute rows a deleted run of this id left,
      // as two statements. The insert goes first, so a run that already exists keeps its rows.
      if (this.hot) {
        await this.hot.query(INSERT_RUN, RUNS.encodeRow(toRunRow(run) as Partial<RunRow>));
        await this.hot.query(DELETE_ATTRIBUTES, [run.id]);
        return;
      }
      await this.db.insert(workflowRuns).values(toRunRow(run));
      await this.db.delete(runAttributes).where(eq(runAttributes.runId, run.id));
      return;
    }
    // One transaction: a run is never visible without its attribute rows (or vice versa).
    await this.db.transaction(async (tx) => {
      await tx.insert(workflowRuns).values(toRunRow(run));
      await reindexAttributes(tx, run.id, run.searchAttributes);
    });
  }

  async updateRun(runId: string, inputPatch: Partial<WorkflowRun>): Promise<void> {
    // Writes are unscoped, so preserve tags even when settling a run outside the read scope.
    const patch =
      inputPatch.status && TERMINAL_RUN_STATUSES.includes(inputPatch.status)
        ? await clearTerminalSingletonAdmission(runId, inputPatch, (id) =>
            this.withScope({}).getRun(id),
          )
        : inputPatch;
    const row = toRunPatch(patch);
    const reindex = 'searchAttributes' in patch;
    if (!Object.keys(row).length && !reindex) return;
    // A patch that leaves the attributes alone is one UPDATE, which needs no transaction.
    if (!reindex) {
      if (this.hot) {
        const { text, values } = this.hotRunUpdate(runId, row);
        await this.hot.query(text, values);
        return;
      }
      await this.db.update(workflowRuns).set(row).where(eq(workflowRuns.id, runId));
      return;
    }
    await this.db.transaction(async (tx) => {
      // Drizzle throws on `.set({})`; skip the UPDATE when no mapped column changed.
      if (Object.keys(row).length)
        await tx.update(workflowRuns).set(row).where(eq(workflowRuns.id, runId));
      if (reindex) await reindexAttributes(tx, runId, patch.searchAttributes);
    });
  }

  async updateRunIf(
    runId: string,
    expectedStatuses: RunStatus[],
    inputPatch: Partial<WorkflowRun>,
  ): Promise<boolean> {
    if (expectedStatuses.length === 0) return false;
    // Writes are unscoped, like updateRun.
    const patch =
      inputPatch.status && TERMINAL_RUN_STATUSES.includes(inputPatch.status)
        ? await clearTerminalSingletonAdmission(runId, inputPatch, (id) =>
            this.withScope({}).getRun(id),
          )
        : inputPatch;
    const row = toRunPatch(patch);
    const reindex = 'searchAttributes' in patch;
    const matches = and(eq(workflowRuns.id, runId), inArray(workflowRuns.status, expectedStatuses));
    // A patch that leaves the attributes alone is one conditional UPDATE: no transaction needed.
    if (!reindex && Object.keys(row).length) {
      if (this.hot) {
        const { text, values } = this.hotRunUpdate(runId, row, expectedStatuses);
        return (await this.hot.query(text, values)).length === 1;
      }
      const applied = await this.db
        .update(workflowRuns)
        .set(row)
        .where(matches)
        .returning({ id: workflowRuns.id });
      return applied.length === 1;
    }
    return this.db.transaction(async (tx) => {
      // One conditional UPDATE: a writer racing another blocks on the row lock, then re-evaluates
      // the status predicate against the committed row. With no mapped column to write, the compare
      // is a locking read instead.
      const applied = Object.keys(row).length
        ? (await tx.update(workflowRuns).set(row).where(matches).returning({ id: workflowRuns.id }))
            .length === 1
        : (await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(matches).for('update'))
            .length === 1;
      if (applied && reindex) await reindexAttributes(tx, runId, patch.searchAttributes);
      return applied;
    });
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    if (this.hot) {
      const rows = await this.hot.query(`${SELECT_RUN}${this.hotScope.text} LIMIT 1`, [
        runId,
        ...this.hotScope.values,
      ]);
      return rows[0] ? fromRunRow(RUNS.decode(rows[0])) : null;
    }
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), this.scope()))
      .limit(1);
    return rows[0] ? fromRunRow(rows[0]) : null;
  }

  async getRuns(runIds: string[]): Promise<WorkflowRun[]> {
    if (runIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(and(inArray(workflowRuns.id, [...new Set(runIds)]), this.scope()));
    return rows.map(fromRunRow);
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
    const scoped = this.runFilters({
      ...(policy.scope ?? {}),
      statuses,
      excludeWorkflows: RETENTION_EXCLUDED,
    });
    return this.db.transaction(async (tx) => {
      const ids = new Set<string>();
      if (policy.maxAge != null) {
        const cutoff = new Date(nowMs - parseDuration(policy.maxAge));
        const rows = await tx
          .select({ id: workflowRuns.id, tags: workflowRuns.tags })
          .from(workflowRuns)
          .where(and(...scoped, lt(workflowRuns.updatedAt, cutoff)))
          .orderBy(asc(workflowRuns.updatedAt)) // oldest first
          .limit(limit)
          .for('update', { skipLocked: true });
        // A run whose lifecycle event is still owed is kept until it is published.
        for (const r of rows) if (!retentionKeeps(r.tags)) ids.add(r.id);
      }
      if (policy.maxCount != null && ids.size < limit) {
        // Everything past the newest `maxCount` rows of the status set. The kept window is skipped by
        // OFFSET (no row lock there), and only the rows past it are locked for deletion.
        const rows = await tx
          .select({ id: workflowRuns.id, tags: workflowRuns.tags })
          .from(workflowRuns)
          .where(and(...scoped))
          .orderBy(desc(workflowRuns.updatedAt), desc(workflowRuns.id))
          .limit(limit)
          .offset(policy.maxCount)
          .for('update', { skipLocked: true });
        for (const r of rows) {
          if (ids.size >= limit) break;
          if (!retentionKeeps(r.tags)) ids.add(r.id);
        }
      }
      if (ids.size === 0) return 0;
      const idList = [...ids].slice(0, limit);
      await deleteRunsCascade(tx, idList);
      return idList.length;
    });
  }

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    if (this.hot) {
      const rows = await this.hot.query(SELECT_CHECKPOINT, [runId, seq]);
      return rows[0] ? fromCheckpointRow(CPS.decode(rows[0])) : null;
    }
    const rows = await this.db
      .select()
      .from(stepCheckpoints)
      .where(and(eq(stepCheckpoints.runId, runId), eq(stepCheckpoints.seq, seq)))
      .limit(1);
    return rows[0] ? fromCheckpointRow(rows[0]) : null;
  }

  async getCheckpoints(runId: string, seqs: number[]): Promise<StepCheckpoint[]> {
    const unique = [...new Set(seqs)];
    const rows: (typeof stepCheckpoints.$inferSelect)[] = [];
    for (let at = 0; at < unique.length; at += 500) {
      rows.push(
        ...(await this.db
          .select()
          .from(stepCheckpoints)
          .where(
            and(
              eq(stepCheckpoints.runId, runId),
              inArray(stepCheckpoints.seq, unique.slice(at, at + 500)),
            ),
          )),
      );
    }
    return rows.sort((a, b) => a.seq - b.seq).map(fromCheckpointRow);
  }

  async getCheckpointsForSettle(runId: string, seqs: number[]): Promise<StepCheckpoint[]> {
    const unique = [...new Set(seqs)];
    if (this.hot) {
      if (unique.length === 0) return [];
      const rows = await this.hot.query(SELECT_CHECKPOINTS_FOR_SETTLE, [runId, unique]);
      return rows.map((raw) => fromCheckpointRow(CPS_NO_INPUT.decode(raw)));
    }
    const { input: _input, ...columns } = getTableColumns(stepCheckpoints);
    const rows: Omit<typeof stepCheckpoints.$inferSelect, 'input'>[] = [];
    for (let at = 0; at < unique.length; at += 500) {
      rows.push(
        ...(await this.db
          .select(columns)
          .from(stepCheckpoints)
          .where(
            and(
              eq(stepCheckpoints.runId, runId),
              inArray(stepCheckpoints.seq, unique.slice(at, at + 500)),
            ),
          )),
      );
    }
    return rows
      .sort((a, b) => a.seq - b.seq)
      .map((row) => fromCheckpointRow({ ...row, input: null }));
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    if (this.hot) {
      await this.hot.query(UPSERT_CHECKPOINT, CPS.encodeRow(toCheckpointRow(checkpoint)));
      return;
    }
    await upsertCheckpoint(this.db, checkpoint);
  }

  async saveCheckpoints(checkpoints: StepCheckpoint[]): Promise<void> {
    if (checkpoints.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (let at = 0; at < checkpoints.length; at += CHECKPOINT_BATCH_ROWS) {
        await tx
          .insert(stepCheckpoints)
          .values(checkpoints.slice(at, at + CHECKPOINT_BATCH_ROWS).map(toCheckpointRow))
          .onConflictDoUpdate({
            target: [stepCheckpoints.runId, stepCheckpoints.seq],
            set: excludedSet(stepCheckpoints),
          });
      }
    });
  }

  async saveCheckpointIfPending(checkpoint: StepCheckpoint): Promise<boolean> {
    // One conditional UPDATE: a writer racing a settling result blocks on the row lock, then
    // re-evaluates `status = 'pending'` against the committed row and matches nothing. A missing
    // row matches nothing either, so it is never created.
    const { runId, seq, ...set } = toCheckpointRow(checkpoint);
    const rows = await this.db
      .update(stepCheckpoints)
      .set(set)
      .where(
        and(
          eq(stepCheckpoints.runId, runId),
          eq(stepCheckpoints.seq, seq),
          eq(stepCheckpoints.status, 'pending'),
        ),
      )
      .returning({ seq: stepCheckpoints.seq });
    return rows.length === 1;
  }

  async saveCheckpointsIfPending(checkpoints: StepCheckpoint[]): Promise<boolean[]> {
    const wrote = checkpoints.map(() => false);
    if (checkpoints.length === 0) return wrote;
    // One statement is atomic on its own; several (repeated rows, or more than a chunk) share a
    // transaction so a rejection writes nothing.
    await this.inTransactionIf(oneStatement(checkpoints), async (tx) => {
      // One statement can only update a row once, so a repeated row goes in a later round, which
      // then compares against the earlier entry's write.
      for (const round of distinctRounds(checkpoints)) {
        for (let at = 0; at < round.length; at += CHECKPOINT_BATCH_ROWS) {
          const chunk = round.slice(at, at + CHECKPOINT_BATCH_ROWS);
          const updated = rowsOf<{ run_id: string; seq: number }>(
            await tx.execute(
              updateIfPendingFrom(chunk.map((i) => checkpoints[i] as StepCheckpoint)),
            ),
          );
          const byKey = new Map(chunk.map((i) => [rowKey(checkpoints[i] as StepCheckpoint), i]));
          for (const row of updated) {
            const i = byKey.get(rowKey({ runId: row.run_id, seq: Number(row.seq) }));
            if (i !== undefined) wrote[i] = true;
          }
        }
      }
    });
    return wrote;
  }

  async settleCheckpointsIfPending(settlements: StepSettlement[]): Promise<boolean[]> {
    const wrote = settlements.map(() => false);
    if (settlements.length === 0) return wrote;
    // As saveCheckpointsIfPending, with a statement that writes only what a result changes.
    await this.inTransactionIf(oneStatement(settlements), async (tx) => {
      for (const round of distinctRounds(settlements)) {
        for (let at = 0; at < round.length; at += CHECKPOINT_BATCH_ROWS) {
          const chunk = round.slice(at, at + CHECKPOINT_BATCH_ROWS);
          const updated = rowsOf<{ run_id: string; seq: number }>(
            await tx.execute(
              settleIfPendingFrom(chunk.map((i) => settlements[i] as StepSettlement)),
            ),
          );
          const byKey = new Map(chunk.map((i) => [rowKey(settlements[i] as StepSettlement), i]));
          for (const row of updated) {
            const i = byKey.get(rowKey({ runId: row.run_id, seq: Number(row.seq) }));
            if (i !== undefined) wrote[i] = true;
          }
        }
      }
    });
    return wrote;
  }

  async settleResultsIfPending(
    results: StepResultSettlement[],
  ): Promise<(StepCheckpoint | null)[]> {
    const out: (StepCheckpoint | null)[] = results.map(() => null);
    // A later entry for a row an earlier one settles loses: only the first of each row is sent.
    const seen = new Set<string>();
    const sent = results.flatMap((r, i) => {
      const key = rowKey(r);
      if (seen.has(key)) return [];
      seen.add(key);
      return [i];
    });
    if (sent.length === 0) return out;
    if (this.hot && sent.length <= HOT_SETTLE_MAX_ROWS) {
      const rows = await this.hot.query(
        settleResultsText(sent.length),
        sent.flatMap((i) => settleResultValues(results[i] as StepResultSettlement)),
      );
      const byKey = new Map(sent.map((i) => [rowKey(results[i] as StepResultSettlement), i]));
      for (const raw of rows) {
        const cp = fromCheckpointRow(CPS_NO_INPUT.decode(raw));
        const i = byKey.get(rowKey(cp));
        if (i !== undefined) out[i] = cp;
      }
      return out;
    }
    await this.inTransactionIf(sent.length <= CHECKPOINT_BATCH_ROWS, async (tx) => {
      for (let at = 0; at < sent.length; at += CHECKPOINT_BATCH_ROWS) {
        const chunk = sent.slice(at, at + CHECKPOINT_BATCH_ROWS);
        const rows = rowsOf<Record<string, unknown>>(
          await tx.execute(settleResultsFrom(chunk.map((i) => results[i] as StepResultSettlement))),
        );
        const byKey = new Map(chunk.map((i) => [rowKey(results[i] as StepResultSettlement), i]));
        for (const raw of rows) {
          const cp = fromCheckpointRow(settledRowFromDriver(raw));
          const i = byKey.get(rowKey(cp));
          if (i !== undefined) out[i] = cp;
        }
      }
    });
    return out;
  }

  async insertCheckpointIfAbsent(checkpoint: StepCheckpoint): Promise<boolean> {
    if (this.hot) {
      const values = CPS.encodeRow(toCheckpointRow(checkpoint));
      return (await this.hot.query(INSERT_CHECKPOINT_IF_ABSENT, values)).length === 1;
    }
    const rows = await this.db
      .insert(stepCheckpoints)
      .values(toCheckpointRow(checkpoint))
      .onConflictDoNothing({ target: [stepCheckpoints.runId, stepCheckpoints.seq] })
      .returning({ seq: stepCheckpoints.seq });
    return rows.length === 1;
  }

  async tryLockRunAndGet(
    runId: string,
    owner: string,
    leaseUntilMs: number,
    nowMs: number,
  ): Promise<WorkflowRun | null> {
    // tryLockRun's conditional UPDATE, returning the row it locked.
    if (this.hot) {
      const rows = await this.hot.query(
        `${LOCK_RUN}${this.hotScope.text.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 3}`)} RETURNING ${RUNS.list}`,
        [runId, owner, lockTime(leaseUntilMs), lockTime(nowMs), ...this.hotScope.values],
      );
      return rows[0] ? fromRunRow(RUNS.decode(rows[0])) : null;
    }
    const rows = await this.db
      .update(workflowRuns)
      .set({ lockedBy: owner, lockedUntil: new Date(leaseUntilMs) })
      .where(
        and(
          eq(workflowRuns.id, runId),
          or(isNull(workflowRuns.lockedUntil), lte(workflowRuns.lockedUntil, new Date(nowMs))),
          this.scope(),
        ),
      )
      .returning();
    return rows[0] ? fromRunRow(rows[0]) : null;
  }

  /** Run `work` on the db as is when it is one statement (atomic by itself), else in a transaction. */
  private inTransactionIf<T>(
    single: boolean,
    work: (tx: DrizzlePgDatabase) => Promise<T>,
  ): Promise<T> {
    return single ? work(this.db) : this.db.transaction((tx) => work(tx));
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

  async listOrphanedRuns(
    nowMs: number,
    limit: number,
    namespace?: string,
    ownedBy?: OwnedLeaseReclaim,
  ): Promise<WorkflowRun[]> {
    if (limit <= 0) return [];
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          inArray(workflowRuns.status, ['running', 'cancelling']),
          or(
            isNull(workflowRuns.lockedUntil),
            lte(workflowRuns.lockedUntil, new Date(nowMs)),
            // A live lease left by a previous process with the caller's own instance id.
            ownedBy
              ? and(
                  eq(workflowRuns.lockedBy, ownedBy.owner),
                  lt(workflowRuns.lockedUntil, new Date(ownedBy.lockedBefore)),
                )
              : undefined,
          ),
          namespaceFilter(namespace),
          this.scope(),
        ),
      )
      .orderBy(asc(workflowRuns.createdAt))
      .limit(limit);
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

  async claimPendingRuns(
    limit: number,
    owner: string,
    leaseUntilMs: number,
    nowMs: number,
    namespace?: string,
  ): Promise<WorkflowRun[]> {
    if (limit <= 0) return [];
    // One statement: pick the oldest free pending rows, skipping any another claimer holds locked
    // right now, and lease them. Several pollers at once each get a different slice.
    const filters = and(
      eq(workflowRuns.status, 'pending'),
      or(isNull(workflowRuns.lockedUntil), lte(workflowRuns.lockedUntil, new Date(nowMs))),
      namespaceFilter(namespace),
      this.scope(),
    );
    const returning = sql.join(
      RUNS.columns.map(([, column]) => sql`r.${sql.identifier(column.name)}`),
      sql`, `,
    );
    const rows = rowsOf<Record<string, unknown>>(
      // A CTE, MATERIALIZED, picks the rows once. As a subquery in UPDATE ... FROM, Postgres may
      // rescan it, and each rescan skips the rows this statement already updated and takes the
      // next ones, so a claim of `limit` rows could lease every free pending run.
      await this.db.execute(sql`WITH c AS MATERIALIZED (
          SELECT ${workflowRuns.id} AS claimed_id FROM ${workflowRuns}
          WHERE ${filters}
          ORDER BY ${workflowRuns.createdAt}, ${workflowRuns.id}
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${workflowRuns} AS r
        SET ${sql.identifier(getTableColumns(workflowRuns).lockedBy.name)} = ${owner},
          ${sql.identifier(getTableColumns(workflowRuns).lockedUntil.name)} = ${new Date(leaseUntilMs).toISOString()}::timestamptz
        FROM c
        WHERE r.${sql.identifier(getTableColumns(workflowRuns).id.name)} = c.claimed_id
        RETURNING ${returning}`),
    );
    return rows
      .map((raw) => fromRunRow(RUNS.decode(raw)))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async listDueTimers(nowMs: number, namespace?: string, limit?: number): Promise<WorkflowRun[]> {
    const query = this.db
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
      )
      .orderBy(asc(workflowRuns.wakeAt));
    const rows = limit !== undefined ? await query.limit(limit) : await query;
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
    if (this.hot) {
      const rows = await this.hot.query(`${LOCK_RUN} RETURNING "id"`, [
        runId,
        owner,
        lockTime(leaseUntilMs),
        lockTime(nowMs),
      ]);
      return rows.length === 1;
    }
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

  async releaseRunLock(runId: string, owner?: string): Promise<void> {
    if (this.hot) {
      await (owner === undefined
        ? this.hot.query(RELEASE_LOCK, [runId])
        : this.hot.query(`${RELEASE_LOCK} AND "locked_by" = $2`, [runId, owner]));
      return;
    }
    await this.db
      .update(workflowRuns)
      .set({ lockedBy: null, lockedUntil: null })
      .where(
        owner === undefined
          ? eq(workflowRuns.id, runId)
          : and(eq(workflowRuns.id, runId), eq(workflowRuns.lockedBy, owner)),
      );
  }

  async renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    if (this.hot) {
      const rows = await this.hot.query(RENEW_LOCK, [runId, owner, lockTime(leaseUntilMs)]);
      return rows.length === 1;
    }
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
      query.excludeWorkflows?.length
        ? notInArray(workflowRuns.workflow, query.excludeWorkflows)
        : undefined,
      query.updatedAfter !== undefined
        ? gte(workflowRuns.updatedAt, new Date(query.updatedAfter))
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

  async listCheckpointsForReplay(runId: string): Promise<StepCheckpoint[]> {
    if (this.hot) {
      const rows = (await this.hot.query(SELECT_REPLAY, [runId])).map((raw) =>
        CPS_NO_INPUT.decode(raw),
      );
      const open = rows.filter((row) => row.status !== 'completed').map((row) => row.seq);
      const inputs = new Map<number, unknown>();
      if (open.length > 0) {
        for (const raw of await this.hot.query(SELECT_INPUTS, [runId, open])) {
          inputs.set(Number(raw.seq), CPS.decode(raw).input);
        }
      }
      return rows.map((row) => fromCheckpointRow({ ...row, input: inputs.get(row.seq) ?? null }));
    }
    const { input: _input, ...columns } = getTableColumns(stepCheckpoints);
    const rows = await this.db
      .select(columns)
      .from(stepCheckpoints)
      .where(eq(stepCheckpoints.runId, runId))
      .orderBy(asc(stepCheckpoints.seq));
    // An open or failed step keeps its input; read by seq, so a row settled since is still filled.
    const open = rows.filter((row) => row.status !== 'completed').map((row) => row.seq);
    const inputs = new Map<number, unknown>();
    for (let at = 0; at < open.length; at += 500) {
      const found = await this.db
        .select({ seq: stepCheckpoints.seq, input: stepCheckpoints.input })
        .from(stepCheckpoints)
        .where(
          and(
            eq(stepCheckpoints.runId, runId),
            inArray(stepCheckpoints.seq, open.slice(at, at + 500)),
          ),
        );
      for (const row of found) inputs.set(row.seq, row.input);
    }
    return rows.map((row) => fromCheckpointRow({ ...row, input: inputs.get(row.seq) ?? null }));
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

  async hasCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    statuses: StepCheckpoint['status'][],
  ): Promise<boolean> {
    if (statuses.length === 0) return false;
    if (this.hot) {
      const rows = await this.hot.query(HAS_CHECKPOINTS, [runId, fromSeq, toSeq, statuses]);
      return rows.length > 0;
    }
    const rows = await this.db
      .select({ seq: stepCheckpoints.seq })
      .from(stepCheckpoints)
      .where(
        and(
          eq(stepCheckpoints.runId, runId),
          gte(stepCheckpoints.seq, fromSeq),
          lte(stepCheckpoints.seq, toSeq),
          inArray(stepCheckpoints.status, statuses),
        ),
      )
      .orderBy(desc(stepCheckpoints.seq))
      .limit(1);
    return rows.length > 0;
  }

  async countCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    statuses: StepCheckpoint['status'][],
  ): Promise<number> {
    if (statuses.length === 0) return 0;
    if (this.hot) {
      const rows = await this.hot.query(COUNT_CHECKPOINTS, [runId, fromSeq, toSeq, statuses]);
      return Number(rows[0]?.n ?? 0);
    }
    const rows = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(stepCheckpoints)
      .where(
        and(
          eq(stepCheckpoints.runId, runId),
          gte(stepCheckpoints.seq, fromSeq),
          lte(stepCheckpoints.seq, toSeq),
          inArray(stepCheckpoints.status, statuses),
        ),
      );
    return rows[0]?.count ?? 0;
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

  /** {@link StateStore.checkpointStats}: one `GROUP BY parallel_group, status, name_kind` over the
   *  run's checkpoints, so a wide fan comes back as a few bucket rows instead of every member. */
  async checkpointStats(
    runId: string,
    opts?: { group?: string | undefined },
  ): Promise<CheckpointStat[]> {
    const c = stepCheckpoints;
    const nameKind = sql<CheckpointNameKind>`CASE
      WHEN ${c.name} LIKE 'signal:child:%' THEN 'child'
      WHEN ${c.name} LIKE 'fan:%' THEN 'folded'
      WHEN ${c.name} LIKE 'spawn:%' THEN 'spawn'
      ELSE 'step' END`.as('name_kind');
    // Aggregates come back raw from the driver (count/sum as bigint strings, timestamps unparsed);
    // `mapWith` a column decodes them as that column's rows are decoded.
    const rows = await this.db
      .select({
        group: c.parallelGroup,
        status: c.status,
        nameKind,
        count: sql<number>`count(*)`.mapWith(Number),
        minSeq: sql<number>`min(${c.seq})`.mapWith(Number),
        maxSeq: sql<number>`max(${c.seq})`.mapWith(Number),
        minName: sql<string>`min(${c.name})`,
        maxName: sql<string>`max(${c.name})`,
        minEnqueuedAt: sql<Date>`min(coalesce(${c.enqueuedAt}, ${c.startedAt}))`.mapWith(
          c.startedAt,
        ),
        minStartedAt: sql<Date>`min(${c.startedAt})`.mapWith(c.startedAt),
        maxStartedAt: sql<Date>`max(${c.startedAt})`.mapWith(c.startedAt),
        maxFinishedAt: sql<Date>`max(${c.finishedAt})`.mapWith(c.finishedAt),
        sumAttempts: sql<number>`sum(${c.attempts})`.mapWith(Number),
      })
      .from(c)
      .where(
        and(
          eq(c.runId, runId),
          opts?.group !== undefined ? eq(c.parallelGroup, opts.group) : undefined,
        ),
      )
      .groupBy(c.parallelGroup, c.status, sql`name_kind`);
    return rows.map((r) => ({
      ...r,
      group: r.group ?? null,
      status: r.status as StepCheckpoint['status'],
    }));
  }

  /** {@link StateStore.queryCheckpoints}: the run's checkpoints narrowed in SQL, in `seq` order and
   *  paged there, so reading one page of a wide fan never loads the rest of it. */
  async queryCheckpoints(runId: string, query: CheckpointQuery): Promise<StepCheckpoint[]> {
    if (query.statuses?.length === 0 || query.namePrefixes?.length === 0) return [];
    const c = stepCheckpoints;
    const base = this.db
      .select()
      .from(c)
      .where(
        and(
          eq(c.runId, runId),
          query.group !== undefined ? eq(c.parallelGroup, query.group) : undefined,
          // `NOT IN` is never true for a NULL group, so ungrouped rows are kept explicitly.
          query.excludeGroups?.length
            ? or(isNull(c.parallelGroup), notInArray(c.parallelGroup, query.excludeGroups))
            : undefined,
          query.statuses ? inArray(c.status, query.statuses) : undefined,
          query.namePrefixes
            ? or(...query.namePrefixes.map((p) => like(c.name, `${escapeLike(p)}%`)))
            : undefined,
        ),
      )
      .orderBy(asc(c.seq))
      .$dynamic();
    if (query.limit != null) base.limit(query.limit);
    if (query.offset != null) base.offset(query.offset);
    return (await base).map(fromCheckpointRow);
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

  async registerChildWaits(entries: ChildWait[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(signalWaiters)
        .values(
          entries.map(({ waiter }) => ({
            token: waiter.token,
            runId: waiter.runId,
            seq: waiter.seq,
            parallelGroup: waiter.parallelGroup ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: signalWaiters.token,
          set: excludedSet(signalWaiters, ['runId', 'seq', 'parallelGroup']),
        });
      await tx
        .insert(stepCheckpoints)
        .values(entries.map(({ checkpoint }) => toCheckpointRow(checkpoint)))
        .onConflictDoUpdate({
          target: [stepCheckpoints.runId, stepCheckpoints.seq],
          set: excludedSet(stepCheckpoints),
        });
    });
  }

  async compactCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    into: StepCheckpoint,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(stepCheckpoints)
        .where(
          and(
            eq(stepCheckpoints.runId, runId),
            gte(stepCheckpoints.seq, fromSeq),
            lte(stepCheckpoints.seq, toSeq),
          ),
        );
      await upsertCheckpoint(tx, into);
    });
  }

  async listSignalWaitersByRun(runIds: string[]): Promise<SignalWaiter[]> {
    if (runIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(signalWaiters)
      .where(inArray(signalWaiters.runId, runIds));
    return rows.map(fromWaiterRow);
  }

  async hasSignalWaiter(runId: string, tokenPrefix: string): Promise<boolean> {
    const rows = await this.db
      .select({ token: signalWaiters.token })
      .from(signalWaiters)
      .where(
        and(
          eq(signalWaiters.runId, runId),
          like(signalWaiters.token, `${escapeLike(tokenPrefix)}%`),
        ),
      )
      .limit(1);
    return rows.length > 0;
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
    if (this.hot) {
      const [row] = await this.hot.query(TAKE_BUFFERED_SIGNAL, [token]);
      if (!row) return null;
      const payload = row.payload == null ? null : SIGNAL_PAYLOAD.mapFromDriverValue(row.payload);
      return { payload: payload ?? undefined };
    }
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

  async takeOldestBufferedSignal(
    tokens: string[],
  ): Promise<{ token: string; payload: unknown } | null> {
    if (tokens.length === 0) return null;
    // Same claim as takeBufferedSignal, across tokens: SKIP LOCKED, deleted in the same statement.
    const oldest = this.db
      .select({ id: bufferedSignals.id })
      .from(bufferedSignals)
      .where(inArray(bufferedSignals.token, [...new Set(tokens)]))
      .orderBy(asc(bufferedSignals.id))
      .limit(1)
      .for('update', { skipLocked: true });
    const rows = await this.db
      .delete(bufferedSignals)
      .where(inArray(bufferedSignals.id, oldest))
      .returning({ token: bufferedSignals.token, payload: bufferedSignals.payload });
    const row = rows[0];
    return row ? { token: row.token, payload: row.payload ?? undefined } : null;
  }

  async claimSignalId(
    token: string,
    id: string,
    expiresAt: number,
    nowMs: number,
  ): Promise<boolean> {
    // Insert, or take over an expired row (ON CONFLICT ... DO UPDATE ... WHERE locks the row, so of
    // two concurrent takeovers one updates and the other sees the fresh expiry and does nothing).
    const rows = await this.db
      .insert(signalIds)
      .values({ token, signalId: id, expiresAt: new Date(expiresAt) })
      .onConflictDoUpdate({
        target: [signalIds.token, signalIds.signalId],
        set: { expiresAt: new Date(expiresAt) },
        setWhere: lte(signalIds.expiresAt, new Date(nowMs)),
      })
      .returning({ token: signalIds.token });
    return rows.length > 0;
  }

  async releaseSignalId(token: string, id: string): Promise<void> {
    await this.db
      .delete(signalIds)
      .where(and(eq(signalIds.token, token), eq(signalIds.signalId, id)));
  }

  async deleteExpiredSignalIds(nowMs: number, limit: number): Promise<number> {
    const expired = this.db
      .select({ token: signalIds.token, signalId: signalIds.signalId })
      .from(signalIds)
      .where(lte(signalIds.expiresAt, new Date(nowMs)))
      .limit(limit)
      .for('update', { skipLocked: true });
    const rows = await this.db
      .delete(signalIds)
      .where(sql`(${signalIds.token}, ${signalIds.signalId}) in (${expired})`)
      .returning({ token: signalIds.token });
    return rows.length;
  }

  async listBufferedSignals(
    tokenPrefix: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<BufferedSignalRow[]> {
    const rows = await this.db
      .select()
      .from(bufferedSignals)
      .where(
        and(
          like(bufferedSignals.token, `${escapeLike(tokenPrefix)}%`),
          afterId !== undefined ? gt(bufferedSignals.id, Number(afterId)) : undefined,
        ),
      )
      .orderBy(asc(bufferedSignals.id))
      .limit(limit);
    return rows
      .filter((r) => r.token.startsWith(tokenPrefix))
      .map((r) => ({ id: String(r.id), token: r.token, payload: r.payload ?? undefined }));
  }

  async deleteBufferedSignals(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.delete(bufferedSignals).where(inArray(bufferedSignals.id, ids.map(Number)));
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
    if (this.hot) {
      return (await this.hot.query(LIST_BUFFERED_EVENTS, [name, limit])).map((raw) => {
        const r = EVENTS.decode(raw);
        return { id: r.id, payload: r.payload ?? undefined, publishedAt: r.publishedAt.getTime() };
      });
    }
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
    if (this.hot) return (await this.hot.query(REMOVE_BUFFERED_EVENT, [id])).length === 1;
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

/** Rows per `UPDATE … FROM (VALUES …)`: 17 parameters each, well under Postgres's 65535. */
const CHECKPOINT_BATCH_ROWS = 500;

// --- The hot path's statements (node-postgres; see hot-path.ts) --------------------------------
const RUNS = new TableCodec<RunRow>(workflowRuns);
const CPS = new TableCodec<CheckpointRow>(stepCheckpoints);
const CPS_NO_INPUT = new TableCodec<CheckpointRow>(stepCheckpoints, ['input']);
const EVENTS = new TableCodec<typeof bufferedEvents.$inferSelect>(bufferedEvents);
const SIGNAL_PAYLOAD = getTableColumns(bufferedSignals).payload;
const T_RUNS = quote(getTableName(workflowRuns));
const T_CPS = quote(getTableName(stepCheckpoints));
const T_EVENTS = quote(getTableName(bufferedEvents));
const T_SIGNALS = quote(getTableName(bufferedSignals));
const T_ATTRIBUTES = quote(getTableName(runAttributes));
const SELECT_RUN = `SELECT ${RUNS.list} FROM ${T_RUNS} WHERE "id" = $1`;
const INSERT_RUN = `INSERT INTO ${T_RUNS} (${RUNS.list}) VALUES (${placeholders(1, RUNS.columns.length)})`;
const DELETE_ATTRIBUTES = `DELETE FROM ${T_ATTRIBUTES} WHERE "run_id" = $1`;
/** `$1` run, then (after any scope parameters) owner, lease end, now: see tryLockRunAndGet. */
const LOCK_RUN = `UPDATE ${T_RUNS} SET "locked_by" = $2, "locked_until" = $3 WHERE "id" = $1 AND ("locked_until" IS NULL OR "locked_until" <= $4)`;
const RELEASE_LOCK = `UPDATE ${T_RUNS} SET "locked_by" = NULL, "locked_until" = NULL WHERE "id" = $1`;
const RENEW_LOCK = `UPDATE ${T_RUNS} SET "locked_until" = $3 WHERE "id" = $1 AND "locked_by" = $2 RETURNING "id"`;
const SELECT_CHECKPOINT = `SELECT ${CPS.list} FROM ${T_CPS} WHERE "run_id" = $1 AND "seq" = $2 LIMIT 1`;
const SELECT_CHECKPOINTS_FOR_SETTLE = `SELECT ${CPS_NO_INPUT.list} FROM ${T_CPS} WHERE "run_id" = $1 AND "seq" = ANY($2::integer[]) ORDER BY "seq"`;
const SELECT_REPLAY = `SELECT ${CPS_NO_INPUT.list} FROM ${T_CPS} WHERE "run_id" = $1 ORDER BY "seq"`;
const SELECT_INPUTS = `SELECT "seq", "input" FROM ${T_CPS} WHERE "run_id" = $1 AND "seq" = ANY($2::integer[])`;
const CHECKPOINT_VALUES = `(${CPS.list}) VALUES (${placeholders(1, CPS.columns.length)})`;
const UPSERT_CHECKPOINT = `INSERT INTO ${T_CPS} ${CHECKPOINT_VALUES} ON CONFLICT ("run_id", "seq") DO UPDATE SET ${CPS.columns
  .map(([, c]) => `${quote(c.name)} = EXCLUDED.${quote(c.name)}`)
  .join(', ')}`;
const INSERT_CHECKPOINT_IF_ABSENT = `INSERT INTO ${T_CPS} ${CHECKPOINT_VALUES} ON CONFLICT ("run_id", "seq") DO NOTHING RETURNING "seq"`;
const CHECKPOINT_RANGE = `FROM ${T_CPS} WHERE "run_id" = $1 AND "seq" >= $2 AND "seq" <= $3 AND "status" = ANY($4::text[])`;
const HAS_CHECKPOINTS = `SELECT "seq" ${CHECKPOINT_RANGE} ORDER BY "seq" DESC LIMIT 1`;
const COUNT_CHECKPOINTS = `SELECT count(*)::integer AS "n" ${CHECKPOINT_RANGE}`;
const LIST_BUFFERED_EVENTS = `SELECT ${EVENTS.list} FROM ${T_EVENTS} WHERE "name" = $1 ORDER BY "published_at", "id" LIMIT $2`;
const REMOVE_BUFFERED_EVENT = `DELETE FROM ${T_EVENTS} WHERE "id" = $1 RETURNING "id"`;
// MATERIALIZED for the same reason as the run claim: a rescanned subquery could delete more than one.
const TAKE_BUFFERED_SIGNAL = `WITH taken AS MATERIALIZED (SELECT "id" FROM ${T_SIGNALS} WHERE "token" = $1 ORDER BY "id" LIMIT 1 FOR UPDATE SKIP LOCKED) DELETE FROM ${T_SIGNALS} WHERE "id" IN (SELECT "id" FROM taken) RETURNING "payload"`;
/** Results settled per hot-path statement; a wider batch takes the builder's chunked path. */
const HOT_SETTLE_MAX_ROWS = 64;
const settleTexts = new Map<number, string>();

/** A lease timestamp as the builder binds it. */
const lockTime = (ms: number): unknown => RUNS.encode('lockedUntil', new Date(ms));

/** {@link settleResultsFrom} as constant text for `n` rows (8 parameters each), cached per `n`. */
function settleResultsText(n: number): string {
  let text = settleTexts.get(n);
  if (text !== undefined) return text;
  const rows = Array.from({ length: n }, (_, r) => {
    const p = (k: number) => `$${r * 8 + k}`;
    return `(${p(1)}::text, ${p(2)}::integer, ${p(3)}::text, ${p(4)}::jsonb, ${p(5)}::jsonb, ${p(6)}::jsonb, ${p(7)}::timestamptz, ${p(8)}::timestamptz)`;
  });
  text = `UPDATE ${T_CPS} AS c SET status = v.status, output = CASE WHEN v.status = 'completed' THEN v.output ELSE c.output END, error = v.error, events = COALESCE(v.events, c.events), started_at = COALESCE(v.started_at, c.started_at), finished_at = v.finished_at FROM (VALUES ${rows.join(', ')}) AS v(run_id, seq, status, output, error, events, started_at, finished_at) WHERE c.run_id = v.run_id AND c.seq = v.seq AND c.status = 'pending' AND NOT EXISTS (SELECT 1 FROM ${T_RUNS} AS r WHERE r.id = c.run_id AND r.status IN ('cancelled', 'completed')) RETURNING ${CPS_NO_INPUT.columns.map(([, c]) => `c.${quote(c.name)}`).join(', ')}`;
  settleTexts.set(n, text);
  return text;
}

/** One result's parameters for {@link settleResultsText}. */
function settleResultValues(r: StepResultSettlement): unknown[] {
  const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
  return [
    r.runId,
    r.seq,
    r.status,
    json(r.status === 'completed' ? r.output : null),
    json(r.error),
    json(r.events),
    r.startedAt ? r.startedAt.toISOString() : null,
    r.finishedAt.toISOString(),
  ];
}

const rowKey = (cp: { runId: string; seq: number }): string => `${cp.seq}:${cp.runId}`;

/** Indexes of `checkpoints` split into rounds that each name a row at most once, in input order. */
function distinctRounds(checkpoints: { runId: string; seq: number }[]): number[][] {
  const rounds: number[][] = [];
  const seen = new Map<string, number>();
  checkpoints.forEach((cp, i) => {
    const key = rowKey(cp);
    const round = seen.get(key) ?? 0;
    seen.set(key, round + 1);
    const indexes = rounds[round] ?? [];
    rounds[round] = indexes;
    indexes.push(i);
  });
  return rounds;
}

/**
 * `saveCheckpointIfPending` for many rows in one statement: each `VALUES` row overwrites its
 * checkpoint only while that row is still `pending` (a concurrent writer blocks on the row lock,
 * then re-evaluates the predicate against the committed row), and `RETURNING` names the rows that
 * were written. The rows must be distinct.
 */
function updateIfPendingFrom(checkpoints: StepCheckpoint[]): SQL {
  const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
  const ts = (v: Date | null) => (v == null ? null : v.toISOString());
  const values = checkpoints.map((cp) => {
    const r = toCheckpointRow(cp);
    return sql`(${r.runId}::text, ${r.seq}::integer, ${r.name}::text, ${r.kind}::text, ${r.stepId}::text, ${r.status}::text, ${json(r.input)}::jsonb, ${json(r.output)}::jsonb, ${json(r.error)}::jsonb, ${json(r.events)}::jsonb, ${r.attempts}::integer, ${r.workerGroup}::text, ${r.parallelGroup}::text, ${ts(r.wakeAt)}::timestamptz, ${ts(r.enqueuedAt)}::timestamptz, ${ts(r.startedAt)}::timestamptz, ${ts(r.finishedAt)}::timestamptz)`;
  });
  return sql`UPDATE ${stepCheckpoints} AS c SET
    name = v.name, kind = v.kind, step_id = v.step_id, status = v.status, input = v.input,
    output = v.output, error = v.error, events = v.events, attempts = v.attempts,
    worker_group = v.worker_group, parallel_group = v.parallel_group, wake_at = v.wake_at,
    enqueued_at = v.enqueued_at, started_at = v.started_at, finished_at = v.finished_at
  FROM (VALUES ${sql.join(values, sql`, `)}) AS v(run_id, seq, name, kind, step_id, status, input,
    output, error, events, attempts, worker_group, parallel_group, wake_at, enqueued_at, started_at,
    finished_at)
  WHERE c.run_id = v.run_id AND c.seq = v.seq AND c.status = 'pending'
  RETURNING c.run_id, c.seq`;
}

/** {@link updateIfPendingFrom} for settlements: it sets only the columns a step's result writes. */
function settleIfPendingFrom(settlements: StepSettlement[]): SQL {
  const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
  const values = settlements.map(
    (s) =>
      sql`(${s.runId}::text, ${s.seq}::integer, ${s.status}::text, ${json(s.output)}::jsonb, ${json(s.error)}::jsonb, ${json(s.events)}::jsonb, ${s.startedAt.toISOString()}::timestamptz, ${s.finishedAt.toISOString()}::timestamptz)`,
  );
  return sql`UPDATE ${stepCheckpoints} AS c SET
    status = v.status, output = v.output, error = v.error, events = v.events,
    started_at = v.started_at, finished_at = v.finished_at
  FROM (VALUES ${sql.join(values, sql`, `)}) AS v(run_id, seq, status, output, error, events,
    started_at, finished_at)
  WHERE c.run_id = v.run_id AND c.seq = v.seq AND c.status = 'pending'
  RETURNING c.run_id, c.seq`;
}

/** Whether a batch of distinct-or-not rows goes out as a single statement (one round, one chunk). */
function oneStatement(rows: { runId: string; seq: number }[]): boolean {
  if (rows.length > CHECKPOINT_BATCH_ROWS) return false;
  const keys = new Set(rows.map(rowKey));
  return keys.size === rows.length;
}

/** The checkpoint columns a settle reads back: every one but `input`. */
const SETTLED_COLUMNS = (() => {
  const { input: _input, ...columns } = getTableColumns(stepCheckpoints);
  return columns;
})();

/**
 * A row a raw statement returned (column names as stored, values as the driver decoded them) as
 * drizzle would map it, through each column's own decoder, so json and timestamps come back the
 * same on every driver.
 */
function settledRowFromDriver(raw: Record<string, unknown>): CheckpointRow {
  const row: Record<string, unknown> = { input: null };
  for (const [key, column] of Object.entries(SETTLED_COLUMNS)) {
    const value = raw[column.name];
    row[key] = value == null ? null : column.mapFromDriverValue(value);
  }
  return row as CheckpointRow;
}

/**
 * `settleResultsIfPending` for distinct rows in one statement: each result settles its row only
 * while it is `pending` and its run is not finished, keeping what the result does not carry (a failed result's output, absent
 * events or start time), and `RETURNING` reads back every settled row but its input.
 */
function settleResultsFrom(results: StepResultSettlement[]): SQL {
  const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
  const values = results.map(
    (r) =>
      sql`(${r.runId}::text, ${r.seq}::integer, ${r.status}::text, ${json(r.status === 'completed' ? r.output : null)}::jsonb, ${json(r.error)}::jsonb, ${json(r.events)}::jsonb, ${r.startedAt ? r.startedAt.toISOString() : null}::timestamptz, ${r.finishedAt.toISOString()}::timestamptz)`,
  );
  const returning = sql.join(
    Object.values(SETTLED_COLUMNS).map((column) => sql`c.${sql.identifier(column.name)}`),
    sql`, `,
  );
  return sql`UPDATE ${stepCheckpoints} AS c SET
    status = v.status,
    output = CASE WHEN v.status = 'completed' THEN v.output ELSE c.output END,
    error = v.error,
    events = COALESCE(v.events, c.events),
    started_at = COALESCE(v.started_at, c.started_at),
    finished_at = v.finished_at
  FROM (VALUES ${sql.join(values, sql`, `)}) AS v(run_id, seq, status, output, error, events,
    started_at, finished_at)
  WHERE c.run_id = v.run_id AND c.seq = v.seq AND c.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM ${workflowRuns} AS r
      WHERE r.id = c.run_id AND r.status IN ('cancelled', 'completed')
    )
  RETURNING ${returning}`;
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
  // The order singleton admission locks in, so a delete of active runs cannot cycle with a claim.
  await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(inArray(workflowRuns.id, runIds))
    .orderBy(asc(workflowRuns.id))
    .for('update');
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
    namespace: run.namespace || DEFAULT_NAMESPACE, // '' is the default pool too
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
  if ('namespace' in patch) row.namespace = patch.namespace || DEFAULT_NAMESPACE;
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
    namespace: row.namespace || DEFAULT_NAMESPACE, // a legacy '' row reads back as the default pool
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

/**
 * The `ON CONFLICT DO UPDATE` set for a multi-row upsert: each column (or each of `only`) takes the
 * value the conflicting row proposed.
 */
function excludedSet<T extends Table>(table: T, only?: string[]): Record<string, SQL> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([key]) => !only || only.includes(key))
      .map(([key, column]) => [key, sql.raw(`excluded."${column.name}"`)]),
  );
}
