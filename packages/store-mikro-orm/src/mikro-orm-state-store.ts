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
import type { EntityManager, MikroORM } from '@mikro-orm/core';

/** Minimal structural surface of the SQL EntityManager's QueryBuilder (from `@mikro-orm/knex`),
 *  typed here so the adapter needn't add a hard dependency on the knex types — a real SQL-driver EM
 *  satisfies it at runtime. */
interface DurableQueryBuilder<T> {
  where(cond: Record<string, unknown>): DurableQueryBuilder<T>;
  andWhere(cond: string): DurableQueryBuilder<T>;
  orderBy(cond: Record<string, unknown>): DurableQueryBuilder<T>;
  limit(n: number): DurableQueryBuilder<T>;
  offset(n: number): DurableQueryBuilder<T>;
  getResultList(): Promise<T[]>;
}
type SqlEm = EntityManager & {
  createQueryBuilder<T>(entity: unknown, alias: string): DurableQueryBuilder<T>;
};

/** Resolved side-table column names (per the active naming strategy) for the raw EXISTS pushdown. */
interface AttributeColumns {
  table: string;
  /** Side-table FK column (the run id on `durable_run_attributes`). */
  runId: string;
  /** Run table PK column (the `id` on `durable_workflow_runs`) used for the outer correlation. */
  runPk: string;
  key: string;
  strValue: string;
  numValue: string;
}
import {
  BufferedSignalEntity,
  RunAttributeEntity,
  SignalWaiterEntity,
  StepCheckpointEntity,
  WorkflowRunEntity,
} from './entities';
import { ensureMikroOrmDurableSchema } from './schema';

/**
 * MikroORM-backed `StateStore`. Works on any MikroORM driver — Postgres, MySQL, SQLite (tested);
 * timestamps and `wakeAt` use native datetime columns. Each operation runs on a forked
 * EntityManager so it owns its unit of work.
 */
export class MikroOrmStateStore implements StateStore {
  constructor(private readonly orm: MikroORM) {}

  async ensureSchema(): Promise<void> {
    await ensureMikroOrmDurableSchema(this.orm);
  }

  async createRun(run: WorkflowRun): Promise<void> {
    const em = this.orm.em.fork();
    em.create(WorkflowRunEntity, toRunEntity(run));
    await em.flush();
    await this.reindexAttributes(run.id, run.searchAttributes);
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const em = this.orm.em.fork();
    const entity = await em.findOneOrFail(WorkflowRunEntity, { id: runId });
    Object.assign(entity, toRunEntity({ ...fromRunEntity(entity), ...patch } as WorkflowRun));
    await em.flush();
    // Keep the side-table in step with the run's attributes whenever they're patched.
    if ('searchAttributes' in patch) await this.reindexAttributes(runId, patch.searchAttributes);
  }

  /** Rewrite a run's normalized attribute rows: delete the old set, insert the current one. Mirrors
   *  the in-memory store's reindex so the side-table always reflects the run's live searchAttributes. */
  private async reindexAttributes(
    runId: string,
    attributes: WorkflowRun['searchAttributes'],
    forked?: EntityManager,
  ): Promise<void> {
    const em = forked ?? this.orm.em.fork();
    await em.nativeDelete(RunAttributeEntity, { runId });
    const rows = normalizeAttributeRows(runId, attributes);
    if (rows.length) await em.insertMany(RunAttributeEntity, rows);
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const em = this.orm.em.fork();
    const entity = await em.findOne(WorkflowRunEntity, { id: runId });
    return entity ? fromRunEntity(entity) : null;
  }

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const em = this.orm.em.fork();
    const entity = await em.findOne(StepCheckpointEntity, { runId, seq });
    return entity ? fromCheckpointEntity(entity) : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    const em = this.orm.em.fork();
    await em.upsert(StepCheckpointEntity, toCheckpointEntity(checkpoint));
    await em.flush();
  }

  async transaction<T>(
    work: (tx: {
      raw: unknown;
      saveCheckpoint: (cp: StepCheckpoint) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.orm.em.fork().transactional(async (em) =>
      work({
        raw: em,
        saveCheckpoint: async (cp) => {
          await em.upsert(StepCheckpointEntity, toCheckpointEntity(cp));
        },
      }),
    );
  }

  async listIncompleteRuns(): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(WorkflowRunEntity, { status: 'running' });
    return rows.map(fromRunEntity);
  }

  async listPendingRuns(limit: number): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(
      WorkflowRunEntity,
      { status: 'pending' },
      { orderBy: { createdAt: 'asc' }, limit }, // FIFO dispatch
    );
    return rows.map(fromRunEntity);
  }

  async listDueTimers(nowMs: number): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(WorkflowRunEntity, {
      status: 'suspended',
      wakeAt: { $ne: null, $lte: new Date(nowMs) },
    });
    return rows.map(fromRunEntity);
  }

  async tryLockRun(
    runId: string,
    owner: string,
    leaseUntilMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const em = this.orm.em.fork();
    const affected = await em.nativeUpdate(
      WorkflowRunEntity,
      { id: runId, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date(nowMs) } }] },
      { lockedBy: owner, lockedUntil: new Date(leaseUntilMs) },
    );
    return affected === 1;
  }

  async releaseRunLock(runId: string): Promise<void> {
    const em = this.orm.em.fork();
    await em.nativeUpdate(WorkflowRunEntity, { id: runId }, { lockedBy: null, lockedUntil: null });
  }

  async renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    const em = this.orm.em.fork();
    const affected = await em.nativeUpdate(
      WorkflowRunEntity,
      { id: runId, lockedBy: owner },
      { lockedUntil: new Date(leaseUntilMs) },
    );
    return affected === 1;
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const where: Record<string, unknown> = {};
    if (query.workflow) where.workflow = query.workflow;
    // `status IN (...)`; an empty set matches nothing (mirrors the in-memory store). When both the
    // single `status` and `statuses` are set, AND them so the narrower set wins.
    if (query.status && query.statuses) {
      where.$and = [{ status: query.status }, { status: { $in: query.statuses } }];
    } else if (query.status) {
      where.status = query.status;
    } else if (query.statuses) {
      where.status = { $in: query.statuses };
    }
    const orderBy = { createdAt: 'desc' as const }; // newest first — recent runs on top in the dashboard
    // `tags`/attributes need raw SQL pushed through the QueryBuilder:
    //  - tag: `tags` is a JSON column (native json/jsonb on PG/MySQL), and MikroORM JSON-serializes a
    //    `{ $like }` operand (wrapping/escaping the LIKE pattern) so a plain where corrupts it to no
    //    matches. A raw LIKE on the column-as-text matches the quoted token so `etl` doesn't match
    //    `etl-foo`. Postgres `jsonb` rejects `LIKE` directly, so cast to text per dialect.
    //  - attributes: each filter becomes a raw EXISTS against the normalized side-table, so the DB
    //    filters AND paginates — no full scan + in-process filter (ANDed: one EXISTS per filter).
    // Use a QueryBuilder with a fixed root alias `r` so the raw correlations are stable across drivers.
    if (query.tag || query.attributes?.length) {
      const quote = this.idQuote(em);
      const cols = this.attributeColumns(em);
      const qb = (em as SqlEm)
        .createQueryBuilder<WorkflowRunEntity>(WorkflowRunEntity, 'r')
        .where(where)
        .orderBy(orderBy);
      if (query.tag) {
        const tagsCol = this.tagsColumn(em);
        const pattern = `%"${query.tag.replace(/'/g, "''")}"%`;
        const colExpr = this.jsonAsText(em, `${quote('r')}.${quote(tagsCol)}`);
        qb.andWhere(`${colExpr} LIKE '${pattern}'`);
      }
      for (const f of query.attributes ?? []) {
        qb.andWhere(this.attributeExistsSql(f, quote, 'r', cols));
      }
      if (query.limit != null) qb.limit(query.limit);
      if (query.offset != null) qb.offset(query.offset);
      const rows = await qb.getResultList();
      return rows.map(fromRunEntity);
    }
    const rows = await em.find(WorkflowRunEntity, where, {
      ...(query.limit != null ? { limit: query.limit } : {}),
      ...(query.offset != null ? { offset: query.offset } : {}),
      orderBy,
    });
    return rows.map(fromRunEntity);
  }

  /** One attribute predicate as a raw EXISTS subquery on the side-table, correlated to the outer run
   *  alias. `<>` (ne) also excludes runs where the attribute is absent (missing-key-never-matches):
   *  EXISTS already requires a present row, so EXISTS(... <> ...) is exactly ne-with-present. Numeric
   *  operands compare the num column, everything else the str column. Identifiers are quoted per
   *  driver and operands are inlined as literals (string operands are escaped by doubling quotes). */
  private attributeExistsSql(
    f: AttributeFilter,
    quote: (id: string) => string,
    alias: string,
    cols: AttributeColumns,
  ): string {
    const col = attributeColumnFor(f) === 'numValue' ? cols.numValue : cols.strValue;
    const cmp = sqlComparator(f.op);
    const operand = attributeOperand(f);
    const literal =
      typeof operand === 'number' ? String(operand) : `'${String(operand).replace(/'/g, "''")}'`;
    const a = quote(cols.table);
    const sub = quote('a');
    const outerId = `${quote(alias)}.${quote(cols.runPk)}`; // run PK column on the outer alias
    return `EXISTS (SELECT 1 FROM ${a} ${sub} WHERE ${sub}.${quote(cols.runId)} = ${outerId} AND ${sub}.${quote(cols.key)} = '${f.key.replace(/'/g, "''")}' AND ${sub}.${quote(col)} ${cmp} ${literal})`;
  }

  /** Resolve the side-table's actual column names from MikroORM metadata, so the raw EXISTS matches
   *  the active naming strategy (underscore vs camelCase) rather than guessing. The run PK column is
   *  reused for BOTH the outer correlation and the side-table FK (they share the same fieldName). */
  private attributeColumns(em: EntityManager): AttributeColumns {
    const meta = em.getMetadata().get(RunAttributeEntity.name);
    const field = (prop: string) => meta.properties[prop]?.fieldNames?.[0] ?? prop;
    const runMeta = em.getMetadata().get(WorkflowRunEntity.name);
    const runPk = runMeta.properties.id?.fieldNames?.[0] ?? 'id';
    return {
      table: meta.tableName,
      runId: field('runId'),
      runPk,
      key: field('key'),
      strValue: field('strValue'),
      numValue: field('numValue'),
    };
  }

  /** Resolve the `tags` column name from metadata (per the active naming strategy), for the raw LIKE. */
  private tagsColumn(em: EntityManager): string {
    const runMeta = em.getMetadata().get(WorkflowRunEntity.name);
    return runMeta.properties.tags?.fieldNames?.[0] ?? 'tags';
  }

  /** Wrap a JSON column reference so it can be `LIKE`d as text. Postgres `jsonb`/`json` rejects `LIKE`
   *  directly (`operator does not exist: jsonb ~~ unknown`) — cast to `text`; MySQL JSON needs an
   *  explicit `CHAR` cast; SQLite stores JSON as text already, so no cast. */
  private jsonAsText(em: EntityManager, colRef: string): string {
    const platform = String(em.getPlatform().constructor.name).toLowerCase();
    if (platform.includes('postgre')) return `${colRef}::text`;
    if (platform.includes('mysql') || platform.includes('mariadb'))
      return `CAST(${colRef} AS CHAR)`;
    return colRef;
  }

  /** Quote an identifier per the active SQL driver (MySQL/MariaDB backtick, others double-quote). */
  private idQuote(em: EntityManager): (id: string) => string {
    const platform = String(em.getPlatform().constructor.name).toLowerCase();
    const isMysql = platform.includes('mysql') || platform.includes('mariadb');
    const ch = isMysql ? '`' : '"';
    return (id: string) => `${ch}${id}${ch}`;
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(StepCheckpointEntity, { runId }, { orderBy: { seq: 'asc' } });
    return rows.map(fromCheckpointEntity);
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    const em = this.orm.em.fork();
    await em.upsert(SignalWaiterEntity, { ...waiter });
    await em.flush();
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const em = this.orm.em.fork();
    const entity = await em.findOne(SignalWaiterEntity, { token });
    if (!entity) return null;
    const waiter: SignalWaiter = { token: entity.token, runId: entity.runId, seq: entity.seq };
    await em.removeAndFlush(entity);
    return waiter;
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(SignalWaiterEntity, { token: { $like: `${prefix}%` } });
    return rows.map((e) => ({ token: e.token, runId: e.runId, seq: e.seq }));
  }

  async bufferSignal(token: string, payload: unknown): Promise<void> {
    const em = this.orm.em.fork();
    const e = new BufferedSignalEntity();
    e.token = token;
    e.payload = payload ?? null;
    em.persist(e);
    await em.flush();
  }

  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    const em = this.orm.em.fork();
    const entity = await em.findOne(BufferedSignalEntity, { token }, { orderBy: { id: 'asc' } });
    if (!entity) return null;
    const payload = entity.payload ?? undefined;
    await em.removeAndFlush(entity);
    return { payload };
  }
}

function toRunEntity(run: WorkflowRun): WorkflowRunEntity {
  const e = new WorkflowRunEntity();
  e.id = run.id;
  e.workflow = run.workflow;
  e.workflowVersion = run.workflowVersion;
  e.status = run.status;
  e.input = run.input ?? null;
  e.output = run.output ?? null;
  e.error = run.error ?? null;
  if (run.wakeAt != null) e.wakeAt = new Date(run.wakeAt);
  if (run.lockedBy !== undefined) e.lockedBy = run.lockedBy;
  if (run.lockedUntil != null) e.lockedUntil = new Date(run.lockedUntil);
  if (run.recoveryAttempts !== undefined) e.recoveryAttempts = run.recoveryAttempts;
  e.tags = run.tags ?? null;
  e.searchAttributes = run.searchAttributes ?? null;
  e.createdAt = run.createdAt;
  e.updatedAt = run.updatedAt;
  return e;
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
    wakeAt: e.wakeAt?.getTime(),
    lockedBy: e.lockedBy ?? undefined,
    lockedUntil: e.lockedUntil?.getTime(),
    recoveryAttempts: e.recoveryAttempts ?? undefined,
    tags: e.tags ?? undefined,
    searchAttributes: e.searchAttributes ?? undefined,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function toCheckpointEntity(cp: StepCheckpoint): StepCheckpointEntity {
  const e = new StepCheckpointEntity();
  e.runId = cp.runId;
  e.seq = cp.seq;
  e.name = cp.name;
  e.kind = cp.kind;
  e.stepId = cp.stepId;
  e.status = cp.status;
  e.input = cp.input ?? null;
  e.output = cp.output ?? null;
  e.error = cp.error ?? null;
  e.events = cp.events ?? null;
  e.attempts = cp.attempts;
  if (cp.workerGroup !== undefined) e.workerGroup = cp.workerGroup;
  if (cp.wakeAt != null) e.wakeAt = new Date(cp.wakeAt);
  e.enqueuedAt = cp.enqueuedAt;
  e.startedAt = cp.startedAt;
  e.finishedAt = cp.finishedAt;
  return e;
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
    wakeAt: e.wakeAt?.getTime(),
    enqueuedAt: e.enqueuedAt ?? e.startedAt,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
  };
}
