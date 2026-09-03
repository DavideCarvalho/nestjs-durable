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
  type SignalWaiter,
  type StateStore,
  type StepCheckpoint,
  type StepError,
  type StepEvent,
  type WorkflowRun,
  attributePredicateOperands,
  axisIsRunColumn,
  mergeRunFacetRows,
  mergeRunValueFacetRows,
  normalizeAttributeRows,
  parseDuration,
} from '@dudousxd/nestjs-durable-core';
import { raw } from '@mikro-orm/core';
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
  // Aggregate verbs — used only by `runFacets`' GROUP BY, which returns raw rows rather than entities.
  // `addSelect` takes `unknown` because the count is a `raw()` expression, not a field name: passing
  // it as a string makes the builder qualify it with the root alias (`r.count(*)`), which is not a
  // column and fails on every engine.
  select(fields: string[]): DurableQueryBuilder<T>;
  addSelect(field: unknown): DurableQueryBuilder<T>;
  groupBy(fields: string[]): DurableQueryBuilder<T>;
  execute<R>(): Promise<R>;
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
  BufferedEventEntity,
  BufferedSignalEntity,
  RunAttributeEntity,
  SignalWaiterEntity,
  StepCheckpointEntity,
  WorkflowRunEntity,
} from './entities';
import { ensureMikroOrmDurableSchema } from './schema';

/** Options for scoping a `MikroOrmStateStore` to a single tenant namespace. */
export interface MikroOrmStateStoreOptions {
  /**
   * When set, every forked `EntityManager` activates the `namespace` global filter with this value,
   * so reads are confined to the given tenant's rows. Omit (or pass `undefined`) for the operator
   * (control-plane) view that sees all namespaces.
   */
  scope?: {
    namespace?: string;
  };
}

/**
 * MikroORM-backed `StateStore`. Works on any MikroORM driver — Postgres, MySQL, SQLite (tested);
 * timestamps and `wakeAt` use native datetime columns. Each operation runs on a forked
 * EntityManager so it owns its unit of work.
 *
 * Pass `opts.scope.namespace` to confine all reads to a single tenant namespace. Omit for the
 * unscoped operator view (control plane — all namespaces visible).
 */
export class MikroOrmStateStore implements StateStore {
  private readonly scopeNamespace: string | undefined;

  constructor(
    private readonly orm: MikroORM,
    opts?: MikroOrmStateStoreOptions,
  ) {
    this.scopeNamespace = opts?.scope?.namespace;
  }

  /**
   * Derive a store confined to a single tenant `scope.namespace`, sharing this store's ORM (no new
   * connection). Turns the operator (unscoped) store into a tenant-boundary view at wiring time —
   * used by the NestJS module's `scopeReads` option, which receives a pre-built store and can't
   * reconstruct it. Pass `{ namespace: undefined }` for the unscoped operator view.
   */
  withScope(scope: { namespace?: string }): MikroOrmStateStore {
    return new MikroOrmStateStore(this.orm, { scope });
  }

  /**
   * Create a forked EntityManager and activate the `namespace` global filter with the store's
   * scope (if any). All read operations go through this so the tenant boundary is applied
   * uniformly. Write operations (nativeDelete, nativeUpdate, upsert, insertMany) bypass global
   * filters in MikroORM and are unaffected.
   */
  private fork() {
    const em = this.orm.em.fork();
    em.setFilterParams('namespace', { namespace: this.scopeNamespace });
    return em;
  }

  async ensureSchema(): Promise<void> {
    await ensureMikroOrmDurableSchema(this.orm);
  }

  async createRun(run: WorkflowRun): Promise<void> {
    const em = this.fork();
    em.create(WorkflowRunEntity, toRunEntity(run));
    await em.flush();
    await this.reindexAttributes(run.id, run.searchAttributes);
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const em = this.fork();
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
    const em = forked ?? this.fork();
    await em.nativeDelete(RunAttributeEntity, { runId });
    const rows = normalizeAttributeRows(runId, attributes);
    if (rows.length) await em.insertMany(RunAttributeEntity, rows);
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const em = this.fork();
    const entity = await em.findOne(WorkflowRunEntity, { id: runId });
    return entity ? fromRunEntity(entity) : null;
  }

  async deleteRun(runId: string): Promise<void> {
    const em = this.fork();
    // Children first, then the run row — checkpoints, signal waiters, and the normalized
    // attribute side-table, so nothing dangles after the run is gone.
    await em.nativeDelete(StepCheckpointEntity, { runId });
    await em.nativeDelete(SignalWaiterEntity, { runId });
    await em.nativeDelete(RunAttributeEntity, { runId });
    await em.nativeDelete(WorkflowRunEntity, { id: runId });
  }

  async pruneTerminalRuns(policy: RetentionPolicy, nowMs: number, limit: number): Promise<number> {
    if (policy.statuses.length === 0 || limit <= 0) return 0;
    const em = this.fork();
    const status = { $in: policy.statuses };
    // Collect ids that violate EITHER bound (most-restrictive keep): too old, or past the count cap.
    const ids = new Set<string>();

    if (policy.maxAge != null) {
      const cutoff = new Date(nowMs - parseDuration(policy.maxAge));
      const rows = await em.find(
        WorkflowRunEntity,
        { status, updatedAt: { $lt: cutoff } },
        { fields: ['id'], orderBy: { updatedAt: 'asc' }, limit }, // oldest first
      );
      for (const r of rows) ids.add(r.id);
    }

    if (policy.maxCount != null && ids.size < limit) {
      // Everything beyond the newest `maxCount` rows in the status set — skip the kept window via offset.
      const rows = await em.find(
        WorkflowRunEntity,
        { status },
        {
          fields: ['id'],
          orderBy: { updatedAt: 'desc', id: 'desc' },
          limit,
          offset: policy.maxCount,
        },
      );
      for (const r of rows) {
        ids.add(r.id);
        if (ids.size >= limit) break;
      }
    }

    if (ids.size === 0) return 0;
    const idList = [...ids].slice(0, limit);
    const runId = { $in: idList };
    // Cascade children then runs (mirrors deleteRun) in one transaction so a pruned run never dangles.
    await em.transactional(async (tem) => {
      await tem.nativeDelete(StepCheckpointEntity, { runId });
      await tem.nativeDelete(SignalWaiterEntity, { runId });
      await tem.nativeDelete(RunAttributeEntity, { runId });
      await tem.nativeDelete(WorkflowRunEntity, { id: runId });
    });
    return idList.length;
  }

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const em = this.fork();
    const entity = await em.findOne(StepCheckpointEntity, { runId, seq });
    return entity ? fromCheckpointEntity(entity) : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    const em = this.fork();
    await em.upsert(StepCheckpointEntity, toCheckpointEntity(checkpoint));
    await em.flush();
  }

  async transaction<T>(
    work: (tx: {
      raw: unknown;
      saveCheckpoint: (cp: StepCheckpoint) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.fork().transactional(async (em) =>
      work({
        raw: em,
        saveCheckpoint: async (cp) => {
          await em.upsert(StepCheckpointEntity, toCheckpointEntity(cp));
        },
      }),
    );
  }

  async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
    const em = this.fork();
    const rows = await em.find(WorkflowRunEntity, {
      status: { $in: ['running', 'cancelling'] },
      ...(namespace !== undefined ? { namespace } : {}),
    });
    return rows.map(fromRunEntity);
  }

  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    const em = this.fork();
    const rows = await em.find(
      WorkflowRunEntity,
      { status: 'pending', ...(namespace !== undefined ? { namespace } : {}) },
      { orderBy: { createdAt: 'asc' }, limit }, // FIFO dispatch
    );
    return rows.map(fromRunEntity);
  }

  async listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]> {
    const em = this.fork();
    const rows = await em.find(WorkflowRunEntity, {
      status: 'suspended',
      wakeAt: { $ne: null, $lte: new Date(nowMs) },
      ...(namespace !== undefined ? { namespace } : {}),
    });
    return rows.map(fromRunEntity);
  }

  async tryLockRun(
    runId: string,
    owner: string,
    leaseUntilMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const em = this.fork();
    const affected = await em.nativeUpdate(
      WorkflowRunEntity,
      { id: runId, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date(nowMs) } }] },
      { lockedBy: owner, lockedUntil: new Date(leaseUntilMs) },
    );
    return affected === 1;
  }

  async releaseRunLock(runId: string): Promise<void> {
    const em = this.fork();
    await em.nativeUpdate(WorkflowRunEntity, { id: runId }, { lockedBy: null, lockedUntil: null });
  }

  async renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    const em = this.fork();
    const affected = await em.nativeUpdate(
      WorkflowRunEntity,
      { id: runId, lockedBy: owner },
      { lockedUntil: new Date(leaseUntilMs) },
    );
    return affected === 1;
  }

  /** The `where` every run query shares — {@link listRuns} pages it, {@link runFacets} groups it.
   *  Only the predicates MikroORM can express declaratively; `tag`/`attributes` need raw SQL and are
   *  applied by the QueryBuilder path in both callers. */
  private runWhere(query: RunQuery): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    // The single and the plural form of an axis are ANDed when both are set (the single narrows the
    // set), and an empty plural matches nothing — same contract as `status`/`statuses` below. They go
    // through `and()` rather than onto `where` directly because a key can only hold one condition.
    const and: Record<string, unknown>[] = [];
    if (query.workflow) where.workflow = query.workflow;
    if (query.workflows) and.push({ workflow: { $in: query.workflows } });
    if (query.namespace !== undefined) where.namespace = query.namespace;
    if (query.namespaces) and.push({ namespace: { $in: query.namespaces } });
    // Plain equality on the origin column, exactly like `namespace` above. A run whose origin is NULL
    // (created before the column existed, or registered through a path the derivation could not
    // classify) matches NO origin value — it is never folded into some bucket to make the facet look
    // complete. Passing `null` asks for exactly that bucket (`origin IS NULL`), which is how a
    // paginated console offers an "unknown" chip without holding every run in the browser.
    if (query.origin !== undefined) where.origin = query.origin;
    // A set of origins may include `null` (the unattributed bucket). SQL `IN` cannot carry it —
    // `IN (NULL)` is never true — so the absent bucket becomes its own ORed `IS NULL` branch and the
    // named values stay in the `IN`. An empty set produces an empty `$or`, which matches nothing.
    if (query.origins) {
      const named = query.origins.filter((o): o is string => o !== null);
      const branches: Record<string, unknown>[] = [];
      if (named.length) branches.push({ origin: { $in: named } });
      if (query.origins.some((o) => o === null)) branches.push({ origin: null });
      and.push(branches.length ? { $or: branches } : { origin: { $in: [] } });
    }
    // `status IN (...)`; an empty set matches nothing (mirrors the in-memory store). When both the
    // single `status` and `statuses` are set, AND them so the narrower set wins.
    if (query.status && query.statuses) {
      and.push({ status: query.status }, { status: { $in: query.statuses } });
    } else if (query.status) {
      where.status = query.status;
    } else if (query.statuses) {
      where.status = { $in: query.statuses };
    }
    if (and.length) where.$and = and;
    return where;
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const em = this.fork();
    const where = this.runWhere(query);
    const orderBy = { createdAt: 'desc' as const }; // newest first — recent runs on top in the dashboard
    // `tags`/attributes need raw SQL pushed through the QueryBuilder:
    //  - tag: `tags` is a JSON column (native json/jsonb on PG/MySQL), and MikroORM JSON-serializes a
    //    `{ $like }` operand (wrapping/escaping the LIKE pattern) so a plain where corrupts it to no
    //    matches. A raw LIKE on the column-as-text matches the quoted token so `etl` doesn't match
    //    `etl-foo`. Postgres `jsonb` rejects `LIKE` directly, so cast to text per dialect.
    //  - attributes: each filter becomes a raw EXISTS against the normalized side-table, so the DB
    //    filters AND paginates — no full scan + in-process filter (ANDed: one EXISTS per filter).
    // Use a QueryBuilder with a fixed root alias `r` so the raw correlations are stable across drivers.
    if (query.tag || query.tags || query.attributes?.length) {
      const qb = this.runQueryBuilder(em, query, where).orderBy(orderBy);
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

  /** A QueryBuilder over `durable_workflow_runs` (root alias `r`) carrying `where` plus the two
   *  predicates only raw SQL can express — the `tag` JSON LIKE and one EXISTS per attribute filter.
   *  Shared so a facet count and the page it labels are taken over the SAME set. */
  private runQueryBuilder(
    em: EntityManager,
    query: RunQuery,
    where: Record<string, unknown>,
  ): DurableQueryBuilder<WorkflowRunEntity> {
    // MikroORM global filters do not auto-apply to createQueryBuilder, so enforce the scope here
    // explicitly. Mirrors the filter cond's semantics: undefined = no restriction (operator view).
    if (this.scopeNamespace !== undefined) where.namespace = this.scopeNamespace;
    const quote = this.idQuote(em);
    const cols = this.attributeColumns(em);
    const qb = (em as SqlEm)
      .createQueryBuilder<WorkflowRunEntity>(WorkflowRunEntity, 'r')
      .where(where);
    if (query.tag) qb.andWhere(this.tagLikeSql(em, query.tag, quote));
    // ANY of the tags: one LIKE per tag, ORed. An empty set matches nothing, which has to be said
    // explicitly — skipping the clause would WIDEN the query to every run.
    if (query.tags) {
      const branches = query.tags.map((t) => this.tagLikeSql(em, t, quote));
      qb.andWhere(branches.length ? `(${branches.join(' OR ')})` : '1 = 0');
    }
    for (const f of query.attributes ?? []) {
      qb.andWhere(this.attributeExistsSql(f, quote, 'r', cols));
    }
    return qb;
  }

  /** `tags LIKE '%"etl"%'` — the quoted token, so `etl` doesn't match `etl-foo`. See the note in
   *  {@link listRuns} for why this is raw SQL rather than a MikroORM condition. */
  private tagLikeSql(em: EntityManager, tag: string, quote: (id: string) => string): string {
    const pattern = `%"${tag.replace(/'/g, "''")}"%`;
    const colExpr = this.jsonAsText(em, `${quote('r')}.${quote(this.tagsColumn(em))}`);
    return `${colExpr} LIKE '${pattern}'`;
  }

  /** `GROUP BY status, origin` over the same predicates {@link listRuns} pages — one aggregate, so a
   *  console can show whole-set counts next to a bounded page instead of downloading every run to
   *  count them in the browser. */
  async runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    const em = this.fork();
    const meta = em.getMetadata().get(WorkflowRunEntity);
    const statusCol = meta.properties.status?.fieldNames?.[0] ?? 'status';
    const originCol = meta.properties.origin?.fieldNames?.[0] ?? 'origin';
    const rows = await this.runQueryBuilder(em, query, this.runWhere(query))
      .select([`r.${statusCol}`, `r.${originCol}`])
      .addSelect(raw('count(*) as count'))
      .groupBy([`r.${statusCol}`, `r.${originCol}`])
      .execute<{ status: RunStatus; origin: string | null; count: number | string }[]>();
    // MySQL returns `count(*)` as a string on some drivers; normalise before merging.
    return mergeRunFacetRows(rows.map((r) => ({ ...r, count: Number(r.count) })));
  }

  /** Distinct values of one filter axis over the same predicates {@link listRuns} pages. A run-table
   *  column is a `GROUP BY` like {@link runFacets}, exact over the whole matching set; the tag and
   *  attribute axes live outside the row (json array / side table) and are counted from a bounded
   *  page of runs instead — see {@link RunValueFacetOptions.scan}. */
  async runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    if (!axisIsRunColumn(axis)) {
      return this.scannedValueFacets(axis, query, opts);
    }
    const em = this.fork();
    const meta = em.getMetadata().get(WorkflowRunEntity);
    const col = meta.properties[axis.field]?.fieldNames?.[0] ?? axis.field;
    const rows = await this.runQueryBuilder(em, query, this.runWhere(query))
      .select([`r.${col}`])
      .addSelect(raw('count(*) as count'))
      .groupBy([`r.${col}`])
      .execute<Record<string, unknown>[]>();
    return mergeRunValueFacetRows(
      rows.map((row) => ({
        value: (row[axis.field] as string | null | undefined) ?? null,
        count: Number(row.count),
      })),
      opts,
    );
  }

  /**
   * The axes whose values do not live in a column of the run row: `tag` (inside a JSON array) and the
   * two search-attribute axes (a side table). Both read the newest `scan` matching runs.
   *
   * Neither reads a run's PAYLOAD. The obvious implementation — page `listRuns` and count in
   * memory — pulls `input`, `output` and `error` for every run in the window, which on a control
   * plane with real payloads is tens of megabytes fetched to produce a list of a hundred short
   * strings, every time a picker opens. These project the one column each question needs instead:
   * the tags column, or the run ids that then drive one grouped read of the side table.
   */
  private async scannedValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    const em = this.fork();
    const scan = opts?.scan ?? RUN_VALUE_FACET_SCAN;
    const where = this.runWhere(query);
    const runMeta = em.getMetadata().get(WorkflowRunEntity);
    const idCol = runMeta.properties.id?.fieldNames?.[0] ?? 'id';

    if (axis.field === 'tag') {
      const tagsCol = this.tagsColumn(em);
      const rows = await this.runQueryBuilder(em, query, where)
        .select([`r.${tagsCol}`])
        .orderBy({ createdAt: 'desc' })
        .limit(scan)
        .execute<Record<string, unknown>[]>();
      // A JSON column comes back as text on some drivers and as a parsed array on others; both mean
      // the same list.
      const values: { value: string; count: number }[] = [];
      for (const row of rows) {
        const raw = row.tags ?? row[tagsCol];
        const tags = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
        if (!Array.isArray(tags)) continue;
        for (const tag of tags) values.push({ value: String(tag), count: 1 });
      }
      return mergeRunValueFacetRows(values, opts);
    }

    // Attribute axes: the ids of the matching runs, then ONE grouped read of the side table for
    // them. Those rows are (runId, key, value) triples — no payload anywhere.
    const idRows = await this.runQueryBuilder(em, query, where)
      .select([`r.${idCol}`])
      .orderBy({ createdAt: 'desc' })
      .limit(scan)
      .execute<Record<string, unknown>[]>();
    const runIds = idRows.map((row) => String(row.id ?? row[idCol]));
    if (runIds.length === 0) return [];

    const attributes = await em.find(
      RunAttributeEntity,
      axis.field === 'attributeValue'
        ? { runId: { $in: runIds }, key: axis.key }
        : { runId: { $in: runIds } },
    );
    return mergeRunValueFacetRows(
      attributes.map((row) => ({
        value:
          axis.field === 'attributeKey'
            ? row.key
            : // Exactly one typed column is set per row — see normalizeAttributeRows.
              (row.strValue ?? (row.numValue == null ? null : String(row.numValue))),
        count: 1,
      })),
      opts,
    );
  }

  /** One attribute predicate as a raw EXISTS subquery on the side-table, correlated to the outer run
   *  alias. `<>` (ne) also excludes runs where the attribute is absent (missing-key-never-matches):
   *  EXISTS already requires a present row, so EXISTS(... <> ...) is exactly ne-with-present. Numeric
   *  operands compare the num column, everything else the str column. `in` contributes one comparison
   *  per member, ORed inside the single EXISTS — one subquery either way, and an `in` over no values
   *  yields no comparison and so matches nothing. Identifiers are quoted per driver and operands are
   *  inlined as literals (string operands are escaped by doubling quotes). */
  private attributeExistsSql(
    f: AttributeFilter,
    quote: (id: string) => string,
    alias: string,
    cols: AttributeColumns,
  ): string {
    const comparisons = attributePredicateOperands(f).map(({ column, comparator, operand }) => {
      const col = column === 'numValue' ? cols.numValue : cols.strValue;
      const literal =
        typeof operand === 'number' ? String(operand) : `'${String(operand).replace(/'/g, "''")}'`;
      return `${quote('a')}.${quote(col)} ${comparator} ${literal}`;
    });
    if (comparisons.length === 0) return '1 = 0';
    const a = quote(cols.table);
    const sub = quote('a');
    const outerId = `${quote(alias)}.${quote(cols.runPk)}`; // run PK column on the outer alias
    const match = comparisons.length === 1 ? comparisons[0] : `(${comparisons.join(' OR ')})`;
    return `EXISTS (SELECT 1 FROM ${a} ${sub} WHERE ${sub}.${quote(cols.runId)} = ${outerId} AND ${sub}.${quote(cols.key)} = '${f.key.replace(/'/g, "''")}' AND ${match})`;
  }

  /** Resolve the side-table's actual column names from MikroORM metadata, so the raw EXISTS matches
   *  the active naming strategy (underscore vs camelCase) rather than guessing. The run PK column is
   *  reused for BOTH the outer correlation and the side-table FK (they share the same fieldName). */
  private attributeColumns(em: EntityManager): AttributeColumns {
    const meta = em.getMetadata().get(RunAttributeEntity);
    const field = (prop: string) =>
      meta.props.find((p) => p.name === prop)?.fieldNames?.[0] ?? prop;
    const runMeta = em.getMetadata().get(WorkflowRunEntity);
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
    const runMeta = em.getMetadata().get(WorkflowRunEntity);
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
    const em = this.fork();
    const rows = await em.find(StepCheckpointEntity, { runId }, { orderBy: { seq: 'asc' } });
    return rows.map(fromCheckpointEntity);
  }

  async getLatestCheckpointByName(
    runId: string,
    name: string,
  ): Promise<StepCheckpoint | undefined> {
    const em = this.fork();
    const entity = await em.findOne(
      StepCheckpointEntity,
      { runId, name },
      { orderBy: { seq: 'desc' } },
    );
    return entity ? fromCheckpointEntity(entity) : undefined;
  }

  async listCheckpointsByNamePrefix(runId: string, prefixes: string[]): Promise<StepCheckpoint[]> {
    if (prefixes.length === 0) return [];
    const em = this.fork();
    const rows = await em.find(
      StepCheckpointEntity,
      { runId, $or: prefixes.map((p) => ({ name: { $like: `${p}%` } })) },
      { orderBy: { seq: 'asc' } },
    );
    return rows.map(fromCheckpointEntity);
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    const em = this.fork();
    await em.upsert(SignalWaiterEntity, {
      token: waiter.token,
      runId: waiter.runId,
      seq: waiter.seq,
      parallelGroup: waiter.parallelGroup ?? null,
    });
    await em.flush();
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const em = this.fork();
    const entity = await em.findOne(SignalWaiterEntity, { token });
    if (!entity) return null;
    const waiter: SignalWaiter = {
      token: entity.token,
      runId: entity.runId,
      seq: entity.seq,
      parallelGroup: entity.parallelGroup ?? undefined,
    };
    await em.remove(entity).flush();
    return waiter;
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    const em = this.fork();
    const rows = await em.find(SignalWaiterEntity, { token: { $like: `${prefix}%` } });
    return rows.map((e) => ({
      token: e.token,
      runId: e.runId,
      seq: e.seq,
      parallelGroup: e.parallelGroup ?? undefined,
    }));
  }

  async removeSignalWaiter(waiter: SignalWaiter): Promise<void> {
    const em = this.fork();
    // Exact-match delete (token AND runId AND seq) — deleting by `token` alone would remove whatever
    // row currently owns it, even if a different run has since claimed the same token.
    await em.nativeDelete(SignalWaiterEntity, {
      token: waiter.token,
      runId: waiter.runId,
      seq: waiter.seq,
    });
  }

  async bufferSignal(token: string, payload: unknown): Promise<void> {
    const em = this.fork();
    const e = new BufferedSignalEntity();
    e.token = token;
    e.payload = payload ?? null;
    em.persist(e);
    await em.flush();
  }

  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    const em = this.fork();
    const entity = await em.findOne(BufferedSignalEntity, { token }, { orderBy: { id: 'asc' } });
    if (!entity) return null;
    const payload = entity.payload ?? undefined;
    await em.remove(entity).flush();
    return { payload };
  }

  async bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void> {
    const em = this.fork();
    const e = new BufferedEventEntity();
    e.id = input.id;
    e.name = input.name;
    e.payload = input.payload ?? null;
    e.publishedAt = new Date(input.publishedAt);
    em.persist(e);
    await em.flush();
  }

  async listBufferedEvents(
    name: string,
    limit: number,
  ): Promise<Array<{ id: string; payload: unknown; publishedAt: number }>> {
    const em = this.fork();
    const rows = await em.find(
      BufferedEventEntity,
      { name },
      { orderBy: { publishedAt: 'asc' }, limit }, // oldest first
    );
    return rows.map((e) => ({
      id: e.id,
      payload: e.payload ?? undefined,
      publishedAt: e.publishedAt.getTime(),
    }));
  }

  async removeBufferedEvent(id: string): Promise<boolean> {
    const em = this.fork();
    const affected = await em.nativeDelete(BufferedEventEntity, { id });
    return affected > 0;
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
  // Mirror lockedBy: leave the fresh entity's own-`undefined` field untouched when the patch clears
  // the marker, so Object.assign(entity, e) writes NULL (the engine clears it when a decision lands).
  if (run.awaitingDecisionTaskId !== undefined)
    e.awaitingDecisionTaskId = run.awaitingDecisionTaskId;
  if (run.recoveryAttempts !== undefined) e.recoveryAttempts = run.recoveryAttempts;
  e.tags = run.tags ?? null;
  e.searchAttributes = run.searchAttributes ?? null;
  e.priority = run.priority ?? null;
  e.namespace = run.namespace ?? 'default';
  // NOT `?? 'default'` like the line above: an absent origin is genuinely UNKNOWN and must stay NULL
  // (see the column's docblock in ./entities). `null` — not left-undefined — so `Object.assign` in
  // updateRun writes SQL NULL rather than skipping the column.
  e.origin = run.origin ?? null;
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
    awaitingDecisionTaskId: e.awaitingDecisionTaskId ?? undefined,
    recoveryAttempts: e.recoveryAttempts ?? undefined,
    tags: e.tags ?? undefined,
    searchAttributes: e.searchAttributes ?? undefined,
    priority: e.priority ?? undefined,
    namespace: e.namespace,
    // NULL (a row written before the column existed) surfaces as `undefined` = unknown origin.
    origin: e.origin ?? undefined,
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
  if (cp.parallelGroup !== undefined) e.parallelGroup = cp.parallelGroup;
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
    parallelGroup: e.parallelGroup ?? undefined,
    wakeAt: e.wakeAt?.getTime(),
    enqueuedAt: e.enqueuedAt ?? e.startedAt,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
  };
}
