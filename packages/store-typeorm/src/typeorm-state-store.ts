import {
  type AttributeFilter,
  type CheckpointNameKind,
  type CheckpointQuery,
  type CheckpointStat,
  type ChildWait,
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
import {
  Between,
  Brackets,
  type DataSource,
  type EntityManager,
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  Like,
  type Repository,
  type SelectQueryBuilder,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  BufferedEventEntity,
  BufferedSignalEntity,
  RunAttributeEntity,
  ScheduleEntity,
  SignalWaiterEntity,
  StepCheckpointEntity,
  WorkflowRunEntity,
} from './entities';
import {
  type DurableSchemaLogger,
  durableColumnResolver,
  ensureTypeOrmDurableSchema,
} from './schema';

/** {@link checkpointNameKind} as a SQL expression over the `cp` alias, for selecting and grouping. */
const CHECKPOINT_NAME_KIND_SQL =
  "CASE WHEN cp.name LIKE 'signal:child:%' THEN 'child' WHEN cp.name LIKE 'fan:%' THEN 'folded'" +
  " WHEN cp.name LIKE 'spawn:%' THEN 'spawn' ELSE 'step' END";

/** A {@link TypeOrmStateStore.checkpointStats} row as the driver returns it, before conversion. */
interface RawCheckpointStat {
  group: string | null;
  status: StepCheckpoint['status'];
  nameKind: CheckpointNameKind;
  count: number | string;
  minSeq: number | string;
  maxSeq: number | string;
  minName: string;
  maxName: string;
  minEnqueuedAt: unknown;
  minStartedAt: unknown;
  maxStartedAt: unknown;
  maxFinishedAt: unknown;
  sumAttempts: number | string;
}

// SQLite exposes one transaction connection per DataSource. Share this queue across store wrappers
// so simultaneous async claims cannot issue overlapping BEGIN statements on that connection.
const sqliteSingletonClaims = new WeakMap<DataSource, Promise<void>>();

/** Options for a {@link TypeOrmStateStore}. */
export interface TypeOrmStateStoreOptions {
  /**
   * Where `ensureSchema()` (the boot-time auto-schema) reports a schema repair it actually applied
   * — a missing table, column or index it had to add. Defaults to `console`. NestJS's `Logger`
   * satisfies it.
   */
  schemaLogger?: DurableSchemaLogger | undefined;
  /**
   * MySQL: the largest existing durable table `ensureSchema()` will rebuild for a column type
   * change at boot; bigger ones are logged for you to run out of band. See
   * `blockingAlterRowLimit` on `ensureTypeOrmDurableSchema`.
   */
  schemaBlockingAlterRowLimit?: number | undefined;
}

/**
 * TypeORM-backed `StateStore`. Works on any TypeORM driver — Postgres, MySQL, SQLite (tested);
 * timestamps use native datetime columns (MySQL `datetime(6)`) and `wakeAt` is stored as a datetime too.
 */
export class TypeOrmStateStore implements StateStore {
  constructor(
    private readonly dataSource: DataSource,
    private readonly options: TypeOrmStateStoreOptions = {},
  ) {}

  async ensureSchema(): Promise<void> {
    await ensureTypeOrmDurableSchema(this.dataSource, {
      logger: this.options.schemaLogger,
      blockingAlterRowLimit: this.options.schemaBlockingAlterRowLimit,
    });
  }

  private runs() {
    return this.dataSource.getRepository(WorkflowRunEntity);
  }
  private checkpoints() {
    return this.dataSource.getRepository(StepCheckpointEntity);
  }
  private waiters() {
    return this.dataSource.getRepository(SignalWaiterEntity);
  }
  private buffered() {
    return this.dataSource.getRepository(BufferedSignalEntity);
  }
  private bufferedEvents() {
    return this.dataSource.getRepository(BufferedEventEntity);
  }
  private attributes() {
    return this.dataSource.getRepository(RunAttributeEntity);
  }
  private schedules() {
    return this.dataSource.getRepository(ScheduleEntity);
  }

  /** Rewrite a run's normalized attribute rows: delete the old set, insert the current one. Mirrors
   *  the in-memory store's reindex so the side-table always reflects the run's live searchAttributes. */
  private async reindexAttributes(
    runId: string,
    attributes: WorkflowRun['searchAttributes'],
    em?: EntityManager,
  ): Promise<void> {
    const repo = em ? em.getRepository(RunAttributeEntity) : this.attributes();
    await repo.delete({ runId });
    const rows = normalizeAttributeRows(runId, attributes);
    if (rows.length) await repo.insert(rows);
  }

  async tryAdmitSingleton(
    runId: string,
    tag: string,
    workflow: string,
    limit: number,
    retryWakeAt?: number,
  ): Promise<boolean> {
    const previous = sqliteSingletonClaims.get(this.dataSource) ?? Promise.resolve();
    const sqlite = ['sqlite', 'better-sqlite3', 'sqljs'].includes(this.dataSource.options.type);
    let release: (() => void) | undefined;
    if (sqlite) {
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      sqliteSingletonClaims.set(
        this.dataSource,
        previous.then(() => next),
      );
      await previous;
    }
    try {
      return await this.dataSource.transaction(async (em) => {
        const repo = em.getRepository(WorkflowRunEntity);
        const where = { workflow, status: In(SINGLETON_ACTIVE_STATUSES) };
        // Acquire write locks BEFORE taking the admission snapshot (also serializes SQLite writers).
        await repo.update(where, { workflow });
        const runs = (await repo.find({ where })).map(fromRunEntity);
        const tags = singletonAdmissionTags(runs, runId, tag, workflow, limit);
        if (!tags) {
          const patch = singletonAdmissionDenialPatch(runs, runId, tag, workflow, retryWakeAt);
          if (patch)
            await repo.update(
              { id: runId },
              {
                status: 'suspended',
                wakeAt: new Date(patch.wakeAt),
                tags: patch.tags,
                updatedAt: patch.updatedAt,
              },
            );
          return false;
        }
        await repo.update({ id: runId }, { tags });
        return true;
      });
    } finally {
      release?.();
    }
  }

  async createRun(run: WorkflowRun): Promise<void> {
    await this.runs().save(toRunEntity(run));
    await this.reindexAttributes(run.id, run.searchAttributes);
  }

  async updateRun(runId: string, inputPatch: Partial<WorkflowRun>): Promise<void> {
    const patch =
      inputPatch.status && TERMINAL_RUN_STATUSES.includes(inputPatch.status)
        ? await clearTerminalSingletonAdmission(runId, inputPatch, (id) => this.getRun(id))
        : inputPatch;
    // Single UPDATE (no pre-SELECT + save round-trips): map only the patched fields. The query
    // builder still applies the entities' JSON column transformers to the `set` values (as in
    // listRuns/tryLockRun). Preserve the not-found throw any caller may rely on.
    const update = runUpdateSet(patch);
    const result = await this.runs()
      .createQueryBuilder()
      .update()
      .set(update)
      .where({ id: runId })
      .execute();
    if (!result.affected) throw new Error(`run ${runId} not found`);
    // Keep the side-table in step with the run's attributes whenever they're patched.
    if ('searchAttributes' in patch) await this.reindexAttributes(runId, patch.searchAttributes);
  }

  async updateRunIf(
    runId: string,
    expectedStatuses: RunStatus[],
    inputPatch: Partial<WorkflowRun>,
  ): Promise<boolean> {
    if (expectedStatuses.length === 0) return false;
    const patch =
      inputPatch.status && TERMINAL_RUN_STATUSES.includes(inputPatch.status)
        ? await clearTerminalSingletonAdmission(runId, inputPatch, (id) => this.getRun(id))
        : inputPatch;
    // The status predicate is part of the UPDATE itself: the database arbitrates the race, and the
    // changed-row count is the answer (a missing row matches nothing).
    const set = runUpdateSet(patch);
    const where = { id: runId, status: In(expectedStatuses) };
    // Nothing to write but (maybe) the attribute side-table: the compare is a read (TypeORM refuses
    // an UPDATE with no values).
    const matched = Object.keys(set).length
      ? ((await this.runs().createQueryBuilder().update().set(set).where(where).execute())
          .affected ?? 0)
      : await this.runs().countBy(where);
    if (!matched) return false;
    if ('searchAttributes' in patch) await this.reindexAttributes(runId, patch.searchAttributes);
    return true;
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const e = await this.runs().findOneBy({ id: runId });
    return e ? fromRunEntity(e) : null;
  }

  async getRuns(runIds: string[]): Promise<WorkflowRun[]> {
    if (runIds.length === 0) return [];
    const rows = await this.runs().find({ where: { id: In([...new Set(runIds)]) } });
    return rows.map(fromRunEntity);
  }

  async deleteRun(runId: string): Promise<void> {
    // Child rows first, then the run — checkpoints, signal waiters, attribute rows.
    await this.checkpoints().delete({ runId });
    await this.waiters().delete({ runId });
    await this.attributes().delete({ runId });
    await this.runs().delete({ id: runId });
  }

  async deleteRuns(runIds: string[]): Promise<void> {
    if (runIds.length === 0) return;
    // Same cascade as deleteRun, one `IN (...)` per table, atomically.
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(StepCheckpointEntity).delete({ runId: In(runIds) });
      await em.getRepository(SignalWaiterEntity).delete({ runId: In(runIds) });
      await em.getRepository(RunAttributeEntity).delete({ runId: In(runIds) });
      await em.getRepository(WorkflowRunEntity).delete({ id: In(runIds) });
    });
  }

  async pruneTerminalRuns(policy: RetentionPolicy, nowMs: number, limit: number): Promise<number> {
    // Only terminal statuses are ever eligible — a policy naming a live status would race the engine.
    const statuses = policy.statuses.filter((s) => TERMINAL_RUN_STATUSES.includes(s));
    if (statuses.length === 0 || limit <= 0) return 0;
    if (policy.maxAge == null && policy.maxCount == null) return 0;
    // A scoped policy only ever sees (and, for maxCount, counts) the runs its scope matches.
    const scoped = () =>
      this.runQueryBuilder({ ...(policy.scope ?? {}), statuses }).select('r.id', 'id');
    const ids = new Set<string>();
    if (policy.maxAge != null) {
      const cutoff = new Date(nowMs - parseDuration(policy.maxAge));
      const rows: Array<{ id: string }> = await scoped()
        .andWhere('r.updatedAt < :cutoff', { cutoff })
        .orderBy('r.updatedAt', 'ASC') // oldest first
        .limit(limit)
        .getRawMany();
      for (const r of rows) ids.add(r.id);
    }
    if (policy.maxCount != null && ids.size < limit) {
      // Everything past the newest `maxCount` rows of the scoped status set (skipped by OFFSET).
      const rows: Array<{ id: string }> = await scoped()
        .orderBy('r.updatedAt', 'DESC')
        .addOrderBy('r.id', 'DESC')
        .limit(limit)
        .offset(policy.maxCount)
        .getRawMany();
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
    const e = await this.checkpoints().findOneBy({ runId, seq });
    return e ? fromCheckpointEntity(e) : null;
  }

  async getCheckpoints(runId: string, seqs: number[]): Promise<StepCheckpoint[]> {
    const unique = [...new Set(seqs)];
    const rows: StepCheckpointEntity[] = [];
    for (let at = 0; at < unique.length; at += 500) {
      rows.push(
        ...(await this.checkpoints().findBy({ runId, seq: In(unique.slice(at, at + 500)) })),
      );
    }
    return rows.sort((a, b) => a.seq - b.seq).map(fromCheckpointEntity);
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    // upsert = INSERT ... ON CONFLICT DO UPDATE on the (runId, seq) key — drops the pre-SELECT that
    // `.save()` does on each write. JSON column transformers still apply for upsert.
    const entity = toCheckpointEntity(checkpoint) as QueryDeepPartialEntity<StepCheckpointEntity>;
    await this.checkpoints().upsert(entity, ['runId', 'seq']);
  }

  async saveCheckpoints(checkpoints: StepCheckpoint[]): Promise<void> {
    if (checkpoints.length === 0) return;
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(StepCheckpointEntity);
      for (let at = 0; at < checkpoints.length; at += 500) {
        await repo.upsert(
          checkpoints
            .slice(at, at + 500)
            .map((cp) => toCheckpointEntity(cp) as QueryDeepPartialEntity<StepCheckpointEntity>),
          ['runId', 'seq'],
        );
      }
    });
  }

  async saveCheckpointIfPending(checkpoint: StepCheckpoint): Promise<boolean> {
    return updateIfPending(this.checkpoints(), checkpoint);
  }

  async saveCheckpointsIfPending(checkpoints: StepCheckpoint[]): Promise<boolean[]> {
    if (checkpoints.length === 0) return [];
    // In one transaction: lock the batch's rows that are still `pending`, decide each entry in order
    // against them (an entry that settles a row makes a later entry for it lose), then write each
    // row's last winning entry with one upsert per chunk. A rejection writes nothing.
    const lock = !['sqlite', 'better-sqlite3', 'sqljs'].includes(this.dataSource.options.type);
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(StepCheckpointEntity);
      const pending = new Set<string>();
      for (const [runId, seqs] of seqsByRun(checkpoints)) {
        for (let at = 0; at < seqs.length; at += 500) {
          const query = repo
            .createQueryBuilder('c')
            .select(['c.runId', 'c.seq'])
            .where('c.runId = :runId', { runId })
            .andWhere('c.seq IN (:...seqs)', { seqs: seqs.slice(at, at + 500) })
            .andWhere('c.status = :status', { status: 'pending' });
          if (lock) query.setLock('pessimistic_write');
          for (const row of await query.getMany()) pending.add(checkpointKey(row.runId, row.seq));
        }
      }
      const { wrote, writes } = decideIfPending(checkpoints, pending);
      for (let at = 0; at < writes.length; at += 500) {
        await repo.upsert(
          writes.slice(at, at + 500).map(
            (cp) =>
              ({
                ...toCheckpointEntity(cp),
                wakeAt: cp.wakeAt != null ? new Date(cp.wakeAt) : null,
              }) as QueryDeepPartialEntity<StepCheckpointEntity>,
          ),
          ['runId', 'seq'],
        );
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
    return this.dataSource.transaction(async (em) =>
      work({
        raw: em,
        saveCheckpoint: async (cp) => {
          await em.getRepository(StepCheckpointEntity).save(toCheckpointEntity(cp));
        },
      }),
    );
  }

  /**
   * The three worker-poll predicates below (recover / pick up / resume timers) each AND in
   * `namespace` when one is given, and omit the predicate entirely when it is `undefined`. Omitting
   * is NOT the same as `namespace IS NULL`: `undefined` means "no restriction" — the operator /
   * control-plane view that legitimately sees every tenant — whereas a NULL-matching predicate would
   * hide every real run behind an empty result while looking correct in a single-tenant test.
   */
  async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
    const rows = await this.runs().findBy({
      status: In(['running', 'cancelling']),
      ...(namespace !== undefined ? { namespace } : {}),
    });
    return rows.map(fromRunEntity);
  }

  async listOrphanedRuns(
    nowMs: number,
    limit: number,
    namespace?: string,
    ownedBy?: OwnedLeaseReclaim,
  ): Promise<WorkflowRun[]> {
    if (limit <= 0) return [];
    const now = new Date(nowMs);
    const rows = await this.runs().find({
      where: [
        {
          status: In(['running', 'cancelling']),
          lockedUntil: IsNull(),
          ...(namespace !== undefined ? { namespace } : {}),
        },
        {
          status: In(['running', 'cancelling']),
          lockedUntil: LessThanOrEqual(now),
          ...(namespace !== undefined ? { namespace } : {}),
        },
        // A live lease left by a previous process with the caller's own instance id.
        ...(ownedBy
          ? [
              {
                status: In(['running', 'cancelling']),
                lockedBy: ownedBy.owner,
                lockedUntil: LessThan(new Date(ownedBy.lockedBefore)),
                ...(namespace !== undefined ? { namespace } : {}),
              },
            ]
          : []),
      ],
      order: { createdAt: 'ASC' },
      take: limit,
    });
    return rows.map(fromRunEntity);
  }

  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    const rows = await this.runs().find({
      where: { status: 'pending', ...(namespace !== undefined ? { namespace } : {}) },
      order: { createdAt: 'ASC' }, // FIFO dispatch
      take: limit,
    });
    return rows.map(fromRunEntity);
  }

  async listDueTimers(nowMs: number, namespace?: string, limit?: number): Promise<WorkflowRun[]> {
    const rows = await this.runs().find({
      where: {
        status: 'suspended',
        wakeAt: LessThanOrEqual(new Date(nowMs)),
        ...(namespace !== undefined ? { namespace } : {}),
      },
      order: { wakeAt: 'ASC' },
      ...(limit !== undefined ? { take: limit } : {}),
    });
    return rows.map(fromRunEntity);
  }

  async tryLockRun(
    runId: string,
    owner: string,
    leaseUntilMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const result = await this.runs()
      .createQueryBuilder()
      .update()
      .set({ lockedBy: owner, lockedUntil: new Date(leaseUntilMs) })
      .where({ id: runId })
      .andWhere(
        new Brackets((qb) =>
          qb
            .where({ lockedUntil: IsNull() })
            .orWhere({ lockedUntil: LessThanOrEqual(new Date(nowMs)) }),
        ),
      )
      .execute();
    return result.affected === 1;
  }

  async releaseRunLock(runId: string, owner?: string): Promise<void> {
    await this.runs().update(owner === undefined ? { id: runId } : { id: runId, lockedBy: owner }, {
      lockedBy: null,
      lockedUntil: () => 'NULL',
    });
  }

  async renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    const result = await this.runs()
      .createQueryBuilder()
      .update()
      .set({ lockedUntil: new Date(leaseUntilMs) })
      .where({ id: runId, lockedBy: owner })
      .execute();
    return result.affected === 1;
  }

  /** A query builder (root alias `r`) carrying the predicates every run query shares —
   *  {@link listRuns} orders + pages it, {@link runFacets} groups it, so a facet count and the page
   *  it labels are always taken over the same set. */
  private runQueryBuilder(query: RunQuery): SelectQueryBuilder<WorkflowRunEntity> {
    // `tags` carries a custom JSON transformer, and TypeORM applies a column transformer's `to()` to
    // FindOperator values too — so a `Like('%"etl"%')` in a plain `where` would be JSON-stringified
    // and corrupt the LIKE pattern. Use the query builder with a raw parameter to bypass that.
    const qb = this.runs().createQueryBuilder('r');
    if (query.workflow) qb.andWhere('r.workflow = :workflow', { workflow: query.workflow });
    // The plural form of each axis: ORed within itself, ANDed with everything else, and an empty set
    // matches nothing — the contract `statuses` already had, spelled the same way (`1 = 0`).
    if (query.workflows)
      qb.andWhere(
        query.workflows.length ? 'r.workflow IN (:...workflows)' : '1 = 0',
        query.workflows.length ? { workflows: query.workflows } : {},
      );
    // The tenant partition. This is not only a dashboard facet: the engine's execution-timeout sweep
    // finds its in-flight runs through `listRuns({ workflow, status, namespace })`, so without this
    // predicate a namespaced worker would cancel ANOTHER tenant's long-running runs. `undefined`
    // leaves the predicate off = every namespace (the operator view), exactly as in the list methods.
    if (query.namespace !== undefined)
      qb.andWhere('r.namespace = :namespace', { namespace: query.namespace });
    if (query.namespaces)
      qb.andWhere(
        query.namespaces.length ? 'r.namespace IN (:...namespaces)' : '1 = 0',
        query.namespaces.length ? { namespaces: query.namespaces } : {},
      );
    // Which library registered the workflow. Plain equality, so a run whose origin is NULL (created
    // before the column existed, or registered through a path the derivation could not classify)
    // matches NO origin value — it is never folded into a bucket to make the facet look complete.
    // Unknown-origin runs are reachable only with the filter OFF, so "all origins" must stay the
    // default view; a dashboard that filtered by default would make those runs look deleted.
    // `null` asks for exactly that absent bucket, which is how a paginated console offers an
    // "unknown" chip without holding every run in the browser to find them.
    if (query.origin === null) qb.andWhere('r.origin IS NULL');
    else if (query.origin !== undefined)
      qb.andWhere('r.origin = :origin', { origin: query.origin });
    // A set of origins may include `null` (the unattributed bucket), which `IN` cannot carry —
    // `IN (NULL)` is never true — so it becomes its own ORed `IS NULL` branch.
    if (query.origins) {
      const named = query.origins.filter((o): o is string => o !== null);
      const branches: string[] = [];
      if (named.length) branches.push('r.origin IN (:...origins)');
      if (query.origins.some((o) => o === null)) branches.push('r.origin IS NULL');
      qb.andWhere(
        branches.length ? `(${branches.join(' OR ')})` : '1 = 0',
        named.length ? { origins: named } : {},
      );
    }
    if (query.status) qb.andWhere('r.status = :status', { status: query.status });
    if (query.statuses)
      qb.andWhere(
        query.statuses.length ? 'r.status IN (:...statuses)' : '1 = 0',
        query.statuses.length ? { statuses: query.statuses } : {},
      );
    // `tags` is a JSON-text column; match the quoted token so `etl` doesn't match `etl-foo`. NOTE: a
    // leading-wildcard LIKE on JSON text is NOT index-friendly (no B-tree index can serve `%"x"%`), so
    // tag-filtered scans (e.g. singleton admission) are sequential over `durable_runs_workflow_status_idx`'s
    // result set. The `statuses`/`workflow` predicates above bound that scan; if tag scans ever dominate,
    // promote tags to a normalized join table or a JSON/GIN index — a schema change, intentionally not done here.
    if (query.tag) qb.andWhere('r.tags LIKE :tagPattern', { tagPattern: `%"${query.tag}"%` });
    if (query.tags) {
      const branches = query.tags.map((_, i) => `r.tags LIKE :tagPattern${i}`);
      qb.andWhere(
        branches.length ? `(${branches.join(' OR ')})` : '1 = 0',
        Object.fromEntries(query.tags.map((t, i) => [`tagPattern${i}`, `%"${t}"%`])),
      );
    }
    // Typed/range attribute predicates push DOWN into SQL: each filter becomes an EXISTS against the
    // normalized `durable_run_attributes` side-table (indexed on (key, numValue)/(key, strValue)), so
    // the DB does the filtering AND the LIMIT/OFFSET — no full scan + in-process filter. ANDed: a run
    // must satisfy every filter, so one EXISTS per filter.
    if (query.attributes?.length) {
      query.attributes.forEach((f, i) => this.applyAttributeExists(qb, f, i));
    }
    return qb;
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const qb = this.runQueryBuilder(query);
    qb.orderBy('r.createdAt', 'DESC'); // newest first — recent runs on top in the dashboard
    if (query.limit != null) qb.take(query.limit);
    if (query.offset != null) qb.skip(query.offset);
    const rows = await qb.getMany();
    return rows.map(fromRunEntity);
  }

  async countRuns(query: Omit<RunQuery, 'limit' | 'offset'>): Promise<number> {
    return this.runQueryBuilder(query).getCount();
  }

  /** `GROUP BY status, origin` over the same predicates {@link listRuns} pages — one aggregate, so a
   *  console can show whole-set counts next to a bounded page instead of downloading every run to
   *  count them in the browser. */
  async runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    const rows = await this.runQueryBuilder(query)
      .select('r.status', 'status')
      .addSelect('r.origin', 'origin')
      .addSelect('COUNT(*)', 'count')
      .groupBy('r.status')
      .addGroupBy('r.origin')
      .getRawMany<{ status: RunStatus; origin: string | null; count: number | string }>();
    // Most drivers hand `COUNT(*)` back as a string through `getRawMany`; normalise before merging.
    return mergeRunFacetRows(rows.map((r) => ({ ...r, count: Number(r.count) })));
  }

  /** Distinct values of one filter axis over the same predicates {@link listRuns} pages. A run-table
   *  column is a `GROUP BY` like {@link runFacets}, exact over the whole matching set; the tag and
   *  attribute axes live outside the row (json text / side table) and are counted from a bounded page
   *  of runs instead — see `RunValueFacetOptions.scan`. */
  async runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    if (!axisIsRunColumn(axis)) {
      const runs = await this.listRuns({ ...query, limit: opts?.scan ?? RUN_VALUE_FACET_SCAN });
      return runValueFacetsFromRuns(runs, axis, opts);
    }
    const rows = await this.runQueryBuilder(query)
      .select(`r.${axis.field}`, 'value')
      .addSelect('COUNT(*)', 'count')
      .groupBy(`r.${axis.field}`)
      .getRawMany<{ value: string | null; count: number | string }>();
    return mergeRunValueFacetRows(
      rows.map((r) => ({ value: r.value ?? null, count: Number(r.count) })),
      opts,
    );
  }

  /** Add one attribute predicate to `qb` as an EXISTS subquery on the side-table. `i` namespaces the
   *  bind params so multiple ANDed filters don't collide. */
  private applyAttributeExists(
    qb: SelectQueryBuilder<WorkflowRunEntity>,
    f: AttributeFilter,
    i: number,
  ): void {
    // One comparison for a scalar op, one per member for `in` — ORed inside the single EXISTS, since
    // `in`'s operands may be of mixed types and so land in different typed columns.
    const comparisons = attributePredicateOperands(f);
    const keyParam = `attrKey${i}`;
    // Resolve the PHYSICAL column names from the entity metadata so this raw subquery tracks the
    // configured naming (canonical snake_case by default) instead of hardcoding camelCase — which
    // would break the EXISTS pushdown the moment the table is snake_case.
    const resolve = durableColumnResolver(this.dataSource);
    const q = this.idQuote();
    const wrap = (name: string) => `${q}${name}${q}`;
    const runIdCol = wrap(resolve('durable_run_attributes', 'runId'));
    const keyCol = wrap(resolve('durable_run_attributes', 'key'));
    const runPkCol = wrap(resolve('durable_workflow_runs', 'id'));
    const table = wrap('durable_run_attributes');
    // `<>` (ne) must also exclude rows where the attribute is absent: the missing-key-never-matches
    // contract (see core matchesAttributes). EXISTS already requires the key row to be present, and a
    // row only exists when the value is non-null, so EXISTS(... <> ...) gives exactly ne-with-present.
    const a = `a${i}`;
    const params: Record<string, unknown> = { [keyParam]: f.key };
    const branches = comparisons.map(({ column, comparator, operand }, j) => {
      const valParam = `attrVal${i}_${j}`;
      params[valParam] = operand;
      return `${a}.${wrap(resolve('durable_run_attributes', column))} ${comparator} :${valParam}`;
    });
    if (branches.length === 0) {
      qb.andWhere('1 = 0');
      return;
    }
    const match = branches.length === 1 ? branches[0] : `(${branches.join(' OR ')})`;
    const sql = `EXISTS (SELECT 1 FROM ${table} ${a} WHERE ${a}.${runIdCol} = r.${runPkCol} AND ${a}.${keyCol} = :${keyParam} AND ${match})`;
    qb.andWhere(sql, params);
  }

  /** The identifier quote char for the active driver (MySQL backtick, others double-quote). */
  private idQuote(): string {
    const type = String(this.dataSource.options.type);
    return type === 'mysql' || type === 'mariadb' || type === 'aurora-mysql' ? '`' : '"';
  }

  // ---- persisted schedules ----------------------------------------------------------------------

  async saveSchedule(record: ScheduleRecord): Promise<void> {
    await this.schedules().save(toScheduleEntity(record));
  }

  async getSchedule(id: string): Promise<ScheduleRecord | null> {
    const e = await this.schedules().findOneBy({ id });
    return e ? fromScheduleEntity(e) : null;
  }

  /** One conditional UPDATE: the compare-and-set on `next_fire_at` (an exact bigint) is atomic. */
  async updateSchedule(
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt'>>,
    expectedNextFireAt?: number | null,
  ): Promise<boolean> {
    const set: QueryDeepPartialEntity<ScheduleEntity> = {};
    if (patch.namespace !== undefined) set.namespace = patch.namespace;
    if (patch.workflow !== undefined) set.workflow = patch.workflow;
    if (patch.paused !== undefined) set.paused = patch.paused;
    if ('nextFireAt' in patch) set.nextFireAt = patch.nextFireAt ?? null;
    if ('tags' in patch) set.tags = (patch.tags ?? null) as never;
    if (patch.spec !== undefined) set.spec = patch.spec as never;
    if (patch.state !== undefined) set.state = patch.state as never;
    if (patch.updatedAt !== undefined) set.updatedAt = patch.updatedAt;
    if (!Object.keys(set).length) return (await this.getSchedule(id)) !== null;
    const qb = this.schedules().createQueryBuilder().update().set(set).where({ id });
    if (expectedNextFireAt === null) qb.andWhere({ nextFireAt: IsNull() });
    else if (expectedNextFireAt !== undefined) qb.andWhere({ nextFireAt: expectedNextFireAt });
    const result = await qb.execute();
    return (result.affected ?? 0) > 0;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const result = await this.schedules().delete({ id });
    return (result.affected ?? 0) > 0;
  }

  async listSchedules(query: ScheduleQuery): Promise<ScheduleRecord[]> {
    const qb = this.schedules().createQueryBuilder('s');
    if (query.namespace !== undefined)
      qb.andWhere('s.namespace = :namespace', { namespace: query.namespace });
    if (query.workflow !== undefined)
      qb.andWhere('s.workflow = :workflow', { workflow: query.workflow });
    if (query.paused !== undefined) qb.andWhere('s.paused = :paused', { paused: query.paused });
    if (query.tag !== undefined) qb.andWhere('s.tags LIKE :tag', { tag: `%"${query.tag}"%` });
    if (query.dueBy !== undefined)
      qb.andWhere('s.paused = :notPaused AND s.nextFireAt <= :dueBy', {
        notPaused: false,
        dueBy: query.dueBy,
      });
    // Soonest-due first, never-firing (NULL) last, id as the stable tie-break.
    qb.orderBy('CASE WHEN s.nextFireAt IS NULL THEN 1 ELSE 0 END', 'ASC')
      .addOrderBy('s.nextFireAt', 'ASC')
      .addOrderBy('s.id', 'ASC');
    if (query.limit != null) qb.take(query.limit);
    if (query.offset != null) qb.skip(query.offset);
    return (await qb.getMany()).map(fromScheduleEntity);
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    const rows = await this.checkpoints().find({ where: { runId }, order: { seq: 'ASC' } });
    return rows.map(fromCheckpointEntity);
  }

  async getLatestCheckpointByName(
    runId: string,
    name: string,
  ): Promise<StepCheckpoint | undefined> {
    const e = await this.checkpoints().findOne({ where: { runId, name }, order: { seq: 'DESC' } });
    return e ? fromCheckpointEntity(e) : undefined;
  }

  async countCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    statuses: StepCheckpoint['status'][],
  ): Promise<number> {
    if (statuses.length === 0) return 0;
    // A plain `COUNT(*)` over the `(runId, seq)` primary key; `Repository.count` would emit a
    // `COUNT(DISTINCT …)` over the composite key instead.
    const row = await this.checkpoints()
      .createQueryBuilder('cp')
      .select('COUNT(*)', 'count')
      .where({ runId, seq: Between(fromSeq, toSeq), status: In(statuses) })
      .getRawOne<{ count: number | string }>();
    return Number(row?.count ?? 0);
  }

  async listCheckpointsByNamePrefix(runId: string, prefixes: string[]): Promise<StepCheckpoint[]> {
    if (prefixes.length === 0) return [];
    const rows = await this.checkpoints().find({
      where: prefixes.map((p) => ({ runId, name: Like(`${p}%`) })),
      order: { seq: 'ASC' },
    });
    // `LIKE` reads `_` and `%` in the prefix as wildcards, so it can match more than the prefix: keep
    // only the exact matches.
    return rows.filter((r) => prefixes.some((p) => r.name.startsWith(p))).map(fromCheckpointEntity);
  }

  /** `GROUP BY parallelGroup, status, nameKind` over one run's checkpoints — one aggregate, so a run
   *  detail draws a wide fan from a few bucket rows instead of loading every member. The `CASE` is
   *  {@link checkpointNameKind} in SQL, and the date aggregates are hydrated through the driver the
   *  way an entity read hydrates the column, so a bucket compares equal to the in-memory reference. */
  async checkpointStats(
    runId: string,
    opts?: { group?: string | undefined },
  ): Promise<CheckpointStat[]> {
    const qb = this.checkpoints()
      .createQueryBuilder('cp')
      .select('cp.parallelGroup', 'group')
      .addSelect('cp.status', 'status')
      .addSelect(CHECKPOINT_NAME_KIND_SQL, 'nameKind')
      .addSelect('COUNT(*)', 'count')
      .addSelect('MIN(cp.seq)', 'minSeq')
      .addSelect('MAX(cp.seq)', 'maxSeq')
      .addSelect('MIN(cp.name)', 'minName')
      .addSelect('MAX(cp.name)', 'maxName')
      // `listCheckpoints` reads a row without `enqueuedAt` as enqueued when it started.
      .addSelect('MIN(COALESCE(cp.enqueuedAt, cp.startedAt))', 'minEnqueuedAt')
      .addSelect('MIN(cp.startedAt)', 'minStartedAt')
      .addSelect('MAX(cp.startedAt)', 'maxStartedAt')
      .addSelect('MAX(cp.finishedAt)', 'maxFinishedAt')
      .addSelect('SUM(cp.attempts)', 'sumAttempts')
      .where('cp.runId = :runId', { runId });
    if (opts?.group !== undefined) qb.andWhere('cp.parallelGroup = :group', { group: opts.group });
    const rows = await qb
      .groupBy('cp.parallelGroup')
      .addGroupBy('cp.status')
      .addGroupBy(CHECKPOINT_NAME_KIND_SQL)
      .getRawMany<RawCheckpointStat>();
    // A raw aggregate skips entity hydration: drivers hand COUNT/SUM back as strings, and a date
    // aggregate as whatever the driver yields for that column (an ISO-ish string on SQLite).
    const dateColumn = this.dataSource
      .getMetadata(StepCheckpointEntity)
      .findColumnWithPropertyName('startedAt');
    const toDate = (raw: unknown): Date =>
      dateColumn
        ? this.dataSource.driver.prepareHydratedValue(raw, dateColumn)
        : new Date(raw as string);
    return rows.map((r) => ({
      group: r.group ?? null,
      status: r.status,
      nameKind: r.nameKind,
      count: Number(r.count),
      minSeq: Number(r.minSeq),
      maxSeq: Number(r.maxSeq),
      minName: r.minName,
      maxName: r.maxName,
      minEnqueuedAt: toDate(r.minEnqueuedAt),
      minStartedAt: toDate(r.minStartedAt),
      maxStartedAt: toDate(r.maxStartedAt),
      maxFinishedAt: toDate(r.maxFinishedAt),
      sumAttempts: Number(r.sumAttempts),
    }));
  }

  /** One run's checkpoints matching `query`, in `seq` order and paged in SQL — the read the run
   *  detail uses for a fan's failures, its folded checkpoints and one page of members. An empty
   *  `statuses`/`namePrefixes` matches nothing; an empty `excludeGroups` excludes nothing. */
  async queryCheckpoints(runId: string, query: CheckpointQuery): Promise<StepCheckpoint[]> {
    if (query.statuses?.length === 0 || query.namePrefixes?.length === 0) return [];
    const qb = this.checkpoints().createQueryBuilder('cp').where('cp.runId = :runId', { runId });
    if (query.group !== undefined) qb.andWhere('cp.parallelGroup = :group', { group: query.group });
    // `NOT IN` is never true for NULL, so ungrouped rows need their own branch to be kept.
    if (query.excludeGroups?.length) {
      qb.andWhere('(cp.parallelGroup IS NULL OR cp.parallelGroup NOT IN (:...excludeGroups))', {
        excludeGroups: query.excludeGroups,
      });
    }
    if (query.statuses) qb.andWhere('cp.status IN (:...statuses)', { statuses: query.statuses });
    if (query.namePrefixes) {
      // Escaped, so a prefix is matched literally (as `startsWith`) rather than as a LIKE pattern.
      const prefixes = query.namePrefixes.map((p) => `${p.replace(/[!%_]/g, '!$&')}%`);
      const branches = prefixes.map((_, i) => `cp.name LIKE :namePrefix${i} ESCAPE '!'`);
      qb.andWhere(
        `(${branches.join(' OR ')})`,
        Object.fromEntries(prefixes.map((p, i) => [`namePrefix${i}`, p])),
      );
    }
    qb.orderBy('cp.seq', 'ASC');
    if (query.offset != null) qb.offset(query.offset);
    // MySQL has no OFFSET without LIMIT, so an open-ended page gets an unreachable limit.
    if (query.limit != null || query.offset != null) {
      qb.limit(query.limit ?? Number.MAX_SAFE_INTEGER);
    }
    return (await qb.getMany()).map(fromCheckpointEntity);
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    await this.waiters().save({
      token: waiter.token,
      runId: waiter.runId,
      seq: waiter.seq,
      parallelGroup: waiter.parallelGroup ?? null,
    });
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    const rows = await this.waiters().find({ where: { token: Like(`${prefix}%`) } });
    // `LIKE` reads `_` and `%` in the prefix as wildcards, so it can match more than the prefix: keep
    // only the exact matches.
    return rows
      .filter((e) => e.token.startsWith(prefix))
      .map((e) => ({
        token: e.token,
        runId: e.runId,
        seq: e.seq,
        parallelGroup: e.parallelGroup ?? undefined,
      }));
  }

  async registerChildWaits(entries: ChildWait[]): Promise<void> {
    if (entries.length === 0) return;
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(SignalWaiterEntity).upsert(
        entries.map(({ waiter }) => ({
          token: waiter.token,
          runId: waiter.runId,
          seq: waiter.seq,
          parallelGroup: waiter.parallelGroup ?? null,
        })),
        ['token'],
      );
      await em.getRepository(StepCheckpointEntity).upsert(
        entries.map(
          ({ checkpoint }) =>
            toCheckpointEntity(checkpoint) as QueryDeepPartialEntity<StepCheckpointEntity>,
        ),
        ['runId', 'seq'],
      );
    });
  }

  async compactCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    into: StepCheckpoint,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const checkpoints = em.getRepository(StepCheckpointEntity);
      await checkpoints.delete({ runId, seq: Between(fromSeq, toSeq) });
      await checkpoints.upsert(
        toCheckpointEntity(into) as QueryDeepPartialEntity<StepCheckpointEntity>,
        ['runId', 'seq'],
      );
    });
  }

  async listSignalWaitersByRun(runIds: string[]): Promise<SignalWaiter[]> {
    if (runIds.length === 0) return [];
    const rows = await this.waiters().find({ where: { runId: In(runIds) } });
    return rows.map((e) => ({
      token: e.token,
      runId: e.runId,
      seq: e.seq,
      parallelGroup: e.parallelGroup ?? undefined,
    }));
  }

  async hasSignalWaiter(runId: string, tokenPrefix: string): Promise<boolean> {
    // `LIKE` reads `_`/`%` in the prefix as wildcards (and ignores case on some dialects), so a hit is
    // confirmed in JS; only a pattern match that is not a real prefix match pays for the full read.
    const where = { runId, token: Like(`${tokenPrefix}%`) };
    const first = await this.waiters().findOne({ where, select: { token: true } });
    if (!first) return false;
    if (first.token.startsWith(tokenPrefix)) return true;
    const rows = await this.waiters().find({ where, select: { token: true } });
    return rows.some((r) => r.token.startsWith(tokenPrefix));
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const e = await this.waiters().findOneBy({ token });
    if (!e) return null;
    const waiter: SignalWaiter = {
      token: e.token,
      runId: e.runId,
      seq: e.seq,
      parallelGroup: e.parallelGroup ?? undefined,
    };
    await this.waiters().delete({ token });
    return waiter;
  }

  async removeSignalWaiter(waiter: SignalWaiter): Promise<void> {
    // Exact-match delete (token AND runId AND seq) — a plain `delete({ token })` would remove
    // whatever row currently owns the token, even if a different run has since claimed it.
    await this.waiters().delete({ token: waiter.token, runId: waiter.runId, seq: waiter.seq });
  }

  async bufferSignal(token: string, payload: unknown): Promise<void> {
    await this.buffered().save({ token, payload: payload ?? null });
  }

  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    const e = await this.buffered().findOne({ where: { token }, order: { id: 'ASC' } });
    if (!e) return null;
    await this.buffered().delete({ id: e.id });
    return { payload: e.payload ?? undefined };
  }

  async bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void> {
    await this.bufferedEvents().save({
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
    const rows = await this.bufferedEvents().find({
      where: { name },
      order: { publishedAt: 'ASC' }, // oldest first
      take: limit,
    });
    return rows.map((e) => ({
      id: e.id,
      payload: e.payload ?? undefined,
      publishedAt: e.publishedAt.getTime(),
    }));
  }

  async removeBufferedEvent(id: string): Promise<boolean> {
    const result = await this.bufferedEvents().delete({ id });
    return result.affected === 1;
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
    ...(run.wakeAt == null ? {} : { wakeAt: new Date(run.wakeAt) }),
    lockedBy: run.lockedBy ?? null,
    ...(run.lockedUntil == null ? {} : { lockedUntil: new Date(run.lockedUntil) }),
    awaitingDecisionTaskId: run.awaitingDecisionTaskId ?? null,
    ...(run.recoveryAttempts === undefined ? {} : { recoveryAttempts: run.recoveryAttempts }),
    tags: run.tags ?? null,
    searchAttributes: run.searchAttributes ?? null,
    priority: run.priority ?? null,
    // An absent namespace is persisted as `'default'` (what the core `WorkflowRun.namespace` docblock
    // promises), so the column is always a value a worker can match on — the opposite of `origin`
    // below, where NULL is the only honest answer.
    namespace: run.namespace || 'default', // '' is the default pool too
    // Absent origin stays SQL NULL — "unknown", never coerced into a real-looking library name.
    origin: run.origin ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
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
    wakeAt: e.wakeAt == null ? undefined : e.wakeAt.getTime(),
    lockedBy: e.lockedBy ?? undefined,
    lockedUntil: e.lockedUntil == null ? undefined : e.lockedUntil.getTime(),
    awaitingDecisionTaskId: e.awaitingDecisionTaskId ?? undefined,
    recoveryAttempts: e.recoveryAttempts ?? undefined,
    tags: e.tags ?? undefined,
    searchAttributes: e.searchAttributes ?? undefined,
    priority: e.priority ?? undefined,
    // Reported verbatim. A row can only be NULL here if the column was added by hand without the
    // `'default'` back-fill the schema helper applies, and reading it back as `'default'` would then
    // LIE: the row would claim a namespace that its own SQL predicate does not match.
    namespace: e.namespace,
    // NULL (a row written before the column existed) surfaces as `undefined` = unknown origin.
    origin: e.origin ?? undefined,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
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
    input: cp.input ?? null,
    output: cp.output ?? null,
    error: cp.error ?? null,
    events: cp.events ?? null,
    attempts: cp.attempts,
    workerGroup: cp.workerGroup ?? null,
    parallelGroup: cp.parallelGroup ?? null,
    ...(cp.wakeAt == null ? {} : { wakeAt: new Date(cp.wakeAt) }),
    enqueuedAt: cp.enqueuedAt,
    startedAt: cp.startedAt,
    finishedAt: cp.finishedAt,
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
    input: e.input ?? undefined,
    output: e.output ?? undefined,
    error: (e.error ?? undefined) as StepError | undefined,
    events: (e.events ?? undefined) as StepEvent[] | undefined,
    attempts: e.attempts,
    workerGroup: e.workerGroup ?? undefined,
    parallelGroup: e.parallelGroup ?? undefined,
    wakeAt: e.wakeAt == null ? undefined : e.wakeAt.getTime(),
    // Older rows predate enqueuedAt; treat the worker start as enqueue time (queue-wait reads zero).
    enqueuedAt: e.enqueuedAt ?? e.startedAt,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
  };
}

function toScheduleEntity(r: ScheduleRecord): ScheduleEntity {
  const e = new ScheduleEntity();
  e.id = r.id;
  e.namespace = r.namespace;
  e.workflow = r.workflow;
  e.paused = r.paused;
  e.nextFireAt = r.nextFireAt;
  e.tags = r.tags ?? null;
  e.spec = r.spec;
  e.state = r.state;
  e.createdAt = r.createdAt;
  e.updatedAt = r.updatedAt;
  return e;
}

function fromScheduleEntity(e: ScheduleEntity): ScheduleRecord {
  return {
    id: e.id,
    namespace: e.namespace,
    workflow: e.workflow,
    // SQLite/MySQL hand a boolean column back as 0/1.
    paused: Boolean(e.paused),
    nextFireAt: e.nextFireAt == null ? null : Number(e.nextFireAt),
    ...(e.tags ? { tags: e.tags } : {}),
    spec: e.spec ?? {},
    state: e.state ?? {},
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/**
 * One conditional UPDATE: the `status = 'pending'` predicate is the compare, the affected-row count
 * the answer. A missing row matches nothing, so it is never created.
 */
/** The UPDATE `set` for a run patch: only the patched fields, mapped to their columns. */
function runUpdateSet(patch: Partial<WorkflowRun>): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  if ('workflow' in patch) update.workflow = patch.workflow;
  if ('workflowVersion' in patch) update.workflowVersion = patch.workflowVersion;
  if ('status' in patch) update.status = patch.status;
  if ('input' in patch) update.input = patch.input ?? null;
  if ('output' in patch) update.output = patch.output ?? null;
  if ('error' in patch) update.error = patch.error ?? null;
  if ('wakeAt' in patch) update.wakeAt = patch.wakeAt == null ? null : new Date(patch.wakeAt);
  if ('lockedBy' in patch) update.lockedBy = patch.lockedBy ?? null;
  if ('lockedUntil' in patch)
    update.lockedUntil = patch.lockedUntil == null ? null : new Date(patch.lockedUntil);
  if ('awaitingDecisionTaskId' in patch)
    update.awaitingDecisionTaskId = patch.awaitingDecisionTaskId ?? null;
  if ('recoveryAttempts' in patch) update.recoveryAttempts = patch.recoveryAttempts;
  if ('tags' in patch) update.tags = patch.tags ?? null;
  if ('searchAttributes' in patch) update.searchAttributes = patch.searchAttributes ?? null;
  if ('priority' in patch) update.priority = patch.priority ?? null;
  // A patch that clears the namespace still lands on `'default'`, never NULL — the column is the
  // isolation predicate, and a NULL there would match no worker's namespace at all.
  if ('namespace' in patch) update.namespace = patch.namespace || 'default';
  if ('origin' in patch) update.origin = patch.origin ?? null;
  if ('createdAt' in patch) update.createdAt = patch.createdAt;
  if ('updatedAt' in patch) update.updatedAt = patch.updatedAt;
  return update;
}

/** `checkpoints`' distinct seqs, by run. */
function seqsByRun(checkpoints: StepCheckpoint[]): Map<string, number[]> {
  const byRun = new Map<string, Set<number>>();
  for (const { runId, seq } of checkpoints) {
    const seqs = byRun.get(runId) ?? new Set<number>();
    seqs.add(seq);
    byRun.set(runId, seqs);
  }
  return new Map([...byRun].map(([runId, seqs]) => [runId, [...seqs]]));
}

const checkpointKey = (runId: string, seq: number): string => `${runId}\u0000${seq}`;

/**
 * `saveCheckpointsIfPending`'s answers for `checkpoints` against the rows that were `pending` before
 * the batch (`pending`, by {@link checkpointKey}), in order: an entry wins while its row is still
 * pending, and an entry that is not `pending` itself settles the row. `writes` holds each row's
 * last winning entry.
 */
function decideIfPending(
  checkpoints: StepCheckpoint[],
  pending: Set<string>,
): { wrote: boolean[]; writes: StepCheckpoint[] } {
  const wrote: boolean[] = [];
  const writes = new Map<string, StepCheckpoint>();
  for (const checkpoint of checkpoints) {
    const key = checkpointKey(checkpoint.runId, checkpoint.seq);
    if (!pending.has(key)) {
      wrote.push(false);
      continue;
    }
    wrote.push(true);
    writes.set(key, checkpoint);
    if (checkpoint.status !== 'pending') pending.delete(key);
  }
  return { wrote, writes: [...writes.values()] };
}

async function updateIfPending(
  repo: Repository<StepCheckpointEntity>,
  checkpoint: StepCheckpoint,
): Promise<boolean> {
  const { runId, seq, ...data } = toCheckpointEntity(checkpoint);
  const set: QueryDeepPartialEntity<StepCheckpointEntity> = {
    ...(data as QueryDeepPartialEntity<StepCheckpointEntity>),
    wakeAt: checkpoint.wakeAt != null ? new Date(checkpoint.wakeAt) : () => 'NULL',
  };
  for (const key of Object.keys(set) as (keyof typeof set)[]) {
    if (set[key] === undefined) delete set[key];
  }
  const result = await repo
    .createQueryBuilder()
    .update()
    .set(set)
    .where({ runId, seq, status: 'pending' })
    .execute();
  return (result.affected ?? 0) > 0;
}
