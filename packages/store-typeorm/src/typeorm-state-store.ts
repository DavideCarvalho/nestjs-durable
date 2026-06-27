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
  sqlComparator,
} from '@dudousxd/nestjs-durable-core';
import {
  Brackets,
  type DataSource,
  type EntityManager,
  In,
  IsNull,
  LessThanOrEqual,
  Like,
  type SelectQueryBuilder,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  BufferedSignalEntity,
  RunAttributeEntity,
  SignalWaiterEntity,
  StepCheckpointEntity,
  WorkflowRunEntity,
} from './entities';
import { durableColumnResolver, ensureTypeOrmDurableSchema } from './schema';

/**
 * TypeORM-backed `StateStore`. Works on any TypeORM driver — Postgres, MySQL, SQLite (tested);
 * timestamps use native datetime columns and `wakeAt` is stored as a datetime too.
 */
export class TypeOrmStateStore implements StateStore {
  constructor(private readonly dataSource: DataSource) {}

  async ensureSchema(): Promise<void> {
    await ensureTypeOrmDurableSchema(this.dataSource);
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
  private attributes() {
    return this.dataSource.getRepository(RunAttributeEntity);
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

  async createRun(run: WorkflowRun): Promise<void> {
    await this.runs().save(toRunEntity(run));
    await this.reindexAttributes(run.id, run.searchAttributes);
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    // Single UPDATE (no pre-SELECT + save round-trips): map only the patched fields. The query
    // builder still applies the entities' JSON column transformers to the `set` values (as in
    // listRuns/tryLockRun). Preserve the not-found throw any caller may rely on.
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
    if ('recoveryAttempts' in patch) update.recoveryAttempts = patch.recoveryAttempts;
    if ('tags' in patch) update.tags = patch.tags ?? null;
    if ('searchAttributes' in patch) update.searchAttributes = patch.searchAttributes ?? null;
    if ('priority' in patch) update.priority = patch.priority ?? null;
    if ('createdAt' in patch) update.createdAt = patch.createdAt;
    if ('updatedAt' in patch) update.updatedAt = patch.updatedAt;
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

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const e = await this.runs().findOneBy({ id: runId });
    return e ? fromRunEntity(e) : null;
  }

  async deleteRun(runId: string): Promise<void> {
    // Child rows first, then the run — checkpoints, signal waiters, attribute rows.
    await this.checkpoints().delete({ runId });
    await this.waiters().delete({ runId });
    await this.attributes().delete({ runId });
    await this.runs().delete({ id: runId });
  }

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const e = await this.checkpoints().findOneBy({ runId, seq });
    return e ? fromCheckpointEntity(e) : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    // upsert = INSERT ... ON CONFLICT DO UPDATE on the (runId, seq) key — drops the pre-SELECT that
    // `.save()` does on each write. JSON column transformers still apply for upsert.
    const entity = toCheckpointEntity(checkpoint) as QueryDeepPartialEntity<StepCheckpointEntity>;
    await this.checkpoints().upsert(entity, ['runId', 'seq']);
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

  async listIncompleteRuns(): Promise<WorkflowRun[]> {
    const rows = await this.runs().findBy({ status: In(['running', 'cancelling']) });
    return rows.map(fromRunEntity);
  }

  async listPendingRuns(limit: number): Promise<WorkflowRun[]> {
    const rows = await this.runs().find({
      where: { status: 'pending' },
      order: { createdAt: 'ASC' }, // FIFO dispatch
      take: limit,
    });
    return rows.map(fromRunEntity);
  }

  async listDueTimers(nowMs: number): Promise<WorkflowRun[]> {
    const rows = await this.runs().findBy({
      status: 'suspended',
      wakeAt: LessThanOrEqual(new Date(nowMs)),
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

  async releaseRunLock(runId: string): Promise<void> {
    await this.runs().update({ id: runId }, { lockedBy: null, lockedUntil: () => 'NULL' });
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

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    // `tags` carries a custom JSON transformer, and TypeORM applies a column transformer's `to()` to
    // FindOperator values too — so a `Like('%"etl"%')` in a plain `where` would be JSON-stringified
    // and corrupt the LIKE pattern. Use the query builder with a raw parameter to bypass that.
    const qb = this.runs().createQueryBuilder('r');
    if (query.workflow) qb.andWhere('r.workflow = :workflow', { workflow: query.workflow });
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
    // Typed/range attribute predicates push DOWN into SQL: each filter becomes an EXISTS against the
    // normalized `durable_run_attributes` side-table (indexed on (key, numValue)/(key, strValue)), so
    // the DB does the filtering AND the LIMIT/OFFSET — no full scan + in-process filter. ANDed: a run
    // must satisfy every filter, so one EXISTS per filter.
    if (query.attributes?.length) {
      query.attributes.forEach((f, i) => this.applyAttributeExists(qb, f, i));
    }
    qb.orderBy('r.createdAt', 'DESC'); // newest first — recent runs on top in the dashboard
    if (query.limit != null) qb.take(query.limit);
    if (query.offset != null) qb.skip(query.offset);
    const rows = await qb.getMany();
    return rows.map(fromRunEntity);
  }

  /** Add one attribute predicate to `qb` as an EXISTS subquery on the side-table. `i` namespaces the
   *  bind params so multiple ANDed filters don't collide. */
  private applyAttributeExists(
    qb: SelectQueryBuilder<WorkflowRunEntity>,
    f: AttributeFilter,
    i: number,
  ): void {
    const valueProperty = attributeColumnFor(f); // 'numValue' | 'strValue' (entity property)
    const cmp = sqlComparator(f.op);
    const keyParam = `attrKey${i}`;
    const valParam = `attrVal${i}`;
    // Resolve the PHYSICAL column names from the entity metadata so this raw subquery tracks the
    // configured naming (canonical snake_case by default) instead of hardcoding camelCase — which
    // would break the EXISTS pushdown the moment the table is snake_case.
    const resolve = durableColumnResolver(this.dataSource);
    const q = this.idQuote();
    const wrap = (name: string) => `${q}${name}${q}`;
    const runIdCol = wrap(resolve('durable_run_attributes', 'runId'));
    const keyCol = wrap(resolve('durable_run_attributes', 'key'));
    const valueCol = wrap(resolve('durable_run_attributes', valueProperty));
    const runPkCol = wrap(resolve('durable_workflow_runs', 'id'));
    const table = wrap('durable_run_attributes');
    // `<>` (ne) must also exclude rows where the attribute is absent: the missing-key-never-matches
    // contract (see core matchesAttributes). EXISTS already requires the key row to be present, and a
    // row only exists when the value is non-null, so EXISTS(... <> ...) gives exactly ne-with-present.
    const a = `a${i}`;
    const sql = `EXISTS (SELECT 1 FROM ${table} ${a} WHERE ${a}.${runIdCol} = r.${runPkCol} AND ${a}.${keyCol} = :${keyParam} AND ${a}.${valueCol} ${cmp} :${valParam})`;
    qb.andWhere(sql, {
      [keyParam]: f.key,
      [valParam]: attributeOperand(f),
    });
  }

  /** The identifier quote char for the active driver (MySQL backtick, others double-quote). */
  private idQuote(): string {
    const type = String(this.dataSource.options.type);
    return type === 'mysql' || type === 'mariadb' || type === 'aurora-mysql' ? '`' : '"';
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

  async listCheckpointsByNamePrefix(runId: string, prefixes: string[]): Promise<StepCheckpoint[]> {
    if (prefixes.length === 0) return [];
    const rows = await this.checkpoints().find({
      where: prefixes.map((p) => ({ runId, name: Like(`${p}%`) })),
      order: { seq: 'ASC' },
    });
    return rows.map(fromCheckpointEntity);
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
    return rows.map((e) => ({
      token: e.token,
      runId: e.runId,
      seq: e.seq,
      parallelGroup: e.parallelGroup ?? undefined,
    }));
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

  async bufferSignal(token: string, payload: unknown): Promise<void> {
    await this.buffered().save({ token, payload: payload ?? null });
  }

  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    const e = await this.buffered().findOne({ where: { token }, order: { id: 'ASC' } });
    if (!e) return null;
    await this.buffered().delete({ id: e.id });
    return { payload: e.payload ?? undefined };
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
    ...(run.recoveryAttempts === undefined ? {} : { recoveryAttempts: run.recoveryAttempts }),
    tags: run.tags ?? null,
    searchAttributes: run.searchAttributes ?? null,
    priority: run.priority ?? null,
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
    recoveryAttempts: e.recoveryAttempts ?? undefined,
    tags: e.tags ?? undefined,
    searchAttributes: e.searchAttributes ?? undefined,
    priority: e.priority ?? undefined,
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
