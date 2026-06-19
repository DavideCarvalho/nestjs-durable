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
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import {
  bufferedSignals,
  runAttributes,
  signalWaiters,
  stepCheckpoints,
  workflowRuns,
} from './schema';

type RunRow = typeof workflowRuns.$inferSelect;
type CheckpointRow = typeof stepCheckpoints.$inferSelect;
type DrizzleSqlite = BaseSQLiteDatabase<'sync' | 'async', unknown>;

/**
 * Drizzle (SQLite / libSQL) `StateStore`. Pass a drizzle db built with `./schema`. Timestamps are
 * epoch-ms integers (SQLite's 64-bit integers hold them fine). For Postgres or MySQL, use the
 * MikroORM, TypeORM or Prisma adapter.
 */
export class DrizzleStateStore implements StateStore {
  constructor(private readonly db: DrizzleSqlite) {}

  async createRun(run: WorkflowRun): Promise<void> {
    await this.db.insert(workflowRuns).values(toRunRow(run));
    await this.reindexAttributes(run.id, run.searchAttributes);
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const row = toRunPatch(patch);
    // Drizzle throws on `.set({})`; skip the UPDATE when no mapped column actually changed.
    if (Object.keys(row).length)
      await this.db.update(workflowRuns).set(row).where(eq(workflowRuns.id, runId));
    // Keep the side-table in step with the run's attributes whenever they're patched.
    if ('searchAttributes' in patch) await this.reindexAttributes(runId, patch.searchAttributes);
  }

  /** Rewrite a run's normalized attribute rows: delete the old set, insert the current one. Mirrors
   *  the in-memory store's reindex so the side-table always reflects the run's live searchAttributes. */
  private async reindexAttributes(
    runId: string,
    attributes: WorkflowRun['searchAttributes'],
  ): Promise<void> {
    await this.db.delete(runAttributes).where(eq(runAttributes.runId, runId));
    const rows = normalizeAttributeRows(runId, attributes);
    if (rows.length) await this.db.insert(runAttributes).values(rows);
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    return rows[0] ? fromRunRow(rows[0]) : null;
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
    const row = toCheckpointRow(checkpoint);
    await this.db
      .insert(stepCheckpoints)
      .values(row)
      .onConflictDoUpdate({ target: [stepCheckpoints.runId, stepCheckpoints.seq], set: row });
  }

  async transaction<T>(
    work: (tx: {
      raw: unknown;
      saveCheckpoint: (cp: StepCheckpoint) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) =>
      work({
        raw: tx,
        saveCheckpoint: async (cp) => {
          const row = toCheckpointRow(cp);
          await tx
            .insert(stepCheckpoints)
            .values(row)
            .onConflictDoUpdate({
              target: [stepCheckpoints.runId, stepCheckpoints.seq],
              set: row,
            });
        },
      }),
    );
  }

  async listIncompleteRuns(): Promise<WorkflowRun[]> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.status, 'running'));
    return rows.map(fromRunRow);
  }

  async listPendingRuns(limit: number): Promise<WorkflowRun[]> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.status, 'pending'))
      .orderBy(asc(workflowRuns.createdAt)) // FIFO dispatch
      .limit(limit);
    return rows.map(fromRunRow);
  }

  async listDueTimers(nowMs: number): Promise<WorkflowRun[]> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.status, 'suspended'),
          isNotNull(workflowRuns.wakeAt),
          lte(workflowRuns.wakeAt, nowMs),
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
    const result = await this.db
      .update(workflowRuns)
      .set({ lockedBy: owner, lockedUntil: leaseUntilMs })
      .where(
        and(
          eq(workflowRuns.id, runId),
          or(isNull(workflowRuns.lockedUntil), lte(workflowRuns.lockedUntil, nowMs)),
        ),
      );
    return (result as { changes?: number }).changes === 1;
  }

  async releaseRunLock(runId: string): Promise<void> {
    await this.db
      .update(workflowRuns)
      .set({ lockedBy: null, lockedUntil: null })
      .where(eq(workflowRuns.id, runId));
  }

  async renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    const result = await this.db
      .update(workflowRuns)
      .set({ lockedUntil: leaseUntilMs })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.lockedBy, owner)));
    return (result as { changes?: number }).changes === 1;
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const filters = [
      query.workflow ? eq(workflowRuns.workflow, query.workflow) : undefined,
      query.status ? eq(workflowRuns.status, query.status) : undefined,
      // `status IN (...)`; an empty set matches nothing (mirrors the in-memory store).
      query.statuses
        ? query.statuses.length
          ? inArray(workflowRuns.status, query.statuses)
          : sql`1 = 0`
        : undefined,
      // `tags` is JSON text; match the quoted token so `etl` doesn't match `etl-foo`.
      query.tag ? like(workflowRuns.tags, `%"${query.tag}"%`) : undefined,
      // Typed/range attribute predicates push DOWN into SQL: each filter becomes an EXISTS against
      // the normalized `durable_run_attributes` side-table, so the DB filters AND paginates — no
      // full scan + in-process filter. ANDed: a run must satisfy every filter (one EXISTS per filter).
      ...(query.attributes?.map((f) => this.attributeExists(f)) ?? []),
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(workflowRuns.createdAt)) // newest first — recent runs on top in the dashboard
      .limit(query.limit ?? -1)
      .offset(query.offset ?? 0);
    return rows.map(fromRunRow);
  }

  /** One attribute predicate as an EXISTS subquery on the side-table, correlated to the outer run.
   *  `<>` (ne) also excludes runs where the attribute is absent (the missing-key-never-matches
   *  contract): EXISTS already requires the key row to be present, so EXISTS(... <> ...) is exactly
   *  ne-with-present. Numeric operands compare `num_value`, everything else `str_value`. */
  private attributeExists(f: AttributeFilter) {
    const col =
      attributeColumnFor(f) === 'numValue' ? runAttributes.numValue : runAttributes.strValue;
    const cmp = sqlComparator(f.op);
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(runAttributes)
        .where(
          and(
            eq(runAttributes.runId, workflowRuns.id),
            eq(runAttributes.key, f.key),
            sql`${col} ${sql.raw(cmp)} ${attributeOperand(f)}`,
          ),
        ),
    );
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
          or(...prefixes.map((p) => like(stepCheckpoints.name, `${p}%`))),
        ),
      )
      .orderBy(asc(stepCheckpoints.seq));
    return rows.map(fromCheckpointRow);
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    await this.db
      .insert(signalWaiters)
      .values(waiter)
      .onConflictDoUpdate({
        target: signalWaiters.token,
        set: { runId: waiter.runId, seq: waiter.seq },
      });
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const rows = await this.db
      .select()
      .from(signalWaiters)
      .where(eq(signalWaiters.token, token))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    await this.db.delete(signalWaiters).where(eq(signalWaiters.token, token));
    return { token: row.token, runId: row.runId, seq: row.seq };
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    const rows = await this.db
      .select()
      .from(signalWaiters)
      .where(like(signalWaiters.token, `${prefix}%`));
    return rows.map((r) => ({ token: r.token, runId: r.runId, seq: r.seq }));
  }

  async bufferSignal(token: string, payload: unknown): Promise<void> {
    await this.db.insert(bufferedSignals).values({ token, payload: payload ?? null });
  }

  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    const rows = await this.db
      .select()
      .from(bufferedSignals)
      .where(eq(bufferedSignals.token, token))
      .orderBy(asc(bufferedSignals.id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    await this.db.delete(bufferedSignals).where(eq(bufferedSignals.id, row.id));
    return { payload: row.payload ?? undefined };
  }
}

function toRunRow(run: WorkflowRun): RunRow {
  return {
    id: run.id,
    workflow: run.workflow,
    workflowVersion: run.workflowVersion,
    status: run.status,
    input: run.input ?? null,
    output: run.output ?? null,
    error: run.error ?? null,
    wakeAt: run.wakeAt ?? null,
    lockedBy: run.lockedBy ?? null,
    lockedUntil: run.lockedUntil ?? null,
    recoveryAttempts: run.recoveryAttempts ?? null,
    tags: run.tags ?? null,
    searchAttributes: run.searchAttributes ?? null,
    createdAt: run.createdAt.getTime(),
    updatedAt: run.updatedAt.getTime(),
  };
}

function toRunPatch(patch: Partial<WorkflowRun>): Partial<RunRow> {
  // Map EVERY patchable field, using presence (`'x' in patch`) semantics for the nullable ones so a
  // patch can CLEAR a column (e.g. `{ error: undefined }` on completion sets it to NULL — matching
  // the TypeORM / MikroORM / in-memory stores). The two non-null Date fields use a defined-guard
  // since they are never cleared. Previously only 7 fields were mapped, so `updateRun({ tags })` /
  // `{ lockedBy }` / clearing `error` silently no-opped on this adapter.
  const row: Partial<RunRow> = {};
  if ('workflow' in patch) row.workflow = patch.workflow;
  if ('workflowVersion' in patch) row.workflowVersion = patch.workflowVersion;
  if ('status' in patch) row.status = patch.status;
  if ('input' in patch) row.input = patch.input ?? null;
  if ('output' in patch) row.output = patch.output ?? null;
  if ('error' in patch) row.error = patch.error ?? null;
  if ('wakeAt' in patch) row.wakeAt = patch.wakeAt ?? null;
  if ('lockedBy' in patch) row.lockedBy = patch.lockedBy ?? null;
  if ('lockedUntil' in patch) row.lockedUntil = patch.lockedUntil ?? null;
  if ('recoveryAttempts' in patch) row.recoveryAttempts = patch.recoveryAttempts ?? null;
  if ('tags' in patch) row.tags = patch.tags ?? null;
  if ('searchAttributes' in patch) row.searchAttributes = patch.searchAttributes ?? null;
  if (patch.createdAt != null) row.createdAt = patch.createdAt.getTime();
  if (patch.updatedAt != null) row.updatedAt = patch.updatedAt.getTime();
  return row;
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
    wakeAt: row.wakeAt ?? undefined,
    lockedBy: row.lockedBy ?? undefined,
    lockedUntil: row.lockedUntil ?? undefined,
    recoveryAttempts: row.recoveryAttempts ?? undefined,
    tags: row.tags ?? undefined,
    searchAttributes: row.searchAttributes ?? undefined,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
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
    wakeAt: cp.wakeAt ?? null,
    enqueuedAt: (cp.enqueuedAt ?? cp.startedAt).getTime(),
    startedAt: cp.startedAt.getTime(),
    finishedAt: cp.finishedAt.getTime(),
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
    wakeAt: row.wakeAt ?? undefined,
    enqueuedAt: row.enqueuedAt == null ? new Date(row.startedAt) : new Date(row.enqueuedAt),
    startedAt: new Date(row.startedAt),
    finishedAt: new Date(row.finishedAt),
  };
}
