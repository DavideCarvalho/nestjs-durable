/**
 * The canonical physical column names for the durable tables, keyed by table → entity property →
 * column. This is the cross-adapter contract: a run written by one store adapter must be readable by
 * another, so EVERY adapter (TypeORM, MikroORM, Prisma, Drizzle) must map these properties to these
 * exact columns. The canonical convention is `snake_case`.
 *
 * Each adapter has a spec that asserts its physical columns against this map (see `assertDurableColumns`).
 * Without it, adapters silently diverge — one defaulting to its ORM's `snake_case` naming strategy,
 * another keeping the verbatim camelCase property name — and a store swap fails against an existing
 * table with "Unknown column" only at runtime. The map exists so that divergence is a failing unit
 * test, not a production incident.
 *
 * The camelCase ("preserve") naming is simply the property names themselves (the object keys), so no
 * separate map is needed for it.
 */
export const DURABLE_CANONICAL_COLUMNS = {
  durable_workflow_runs: {
    id: 'id',
    workflow: 'workflow',
    workflowVersion: 'workflow_version',
    status: 'status',
    input: 'input',
    output: 'output',
    error: 'error',
    wakeAt: 'wake_at',
    lockedBy: 'locked_by',
    lockedUntil: 'locked_until',
    recoveryAttempts: 'recovery_attempts',
    tags: 'tags',
    searchAttributes: 'search_attributes',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  durable_step_checkpoints: {
    runId: 'run_id',
    seq: 'seq',
    name: 'name',
    kind: 'kind',
    stepId: 'step_id',
    status: 'status',
    input: 'input',
    output: 'output',
    error: 'error',
    events: 'events',
    attempts: 'attempts',
    workerGroup: 'worker_group',
    wakeAt: 'wake_at',
    enqueuedAt: 'enqueued_at',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
  },
  durable_run_attributes: {
    runId: 'run_id',
    key: 'key',
    strValue: 'str_value',
    numValue: 'num_value',
  },
  durable_signal_waiters: {
    token: 'token',
    runId: 'run_id',
    seq: 'seq',
  },
  durable_buffered_signals: {
    id: 'id',
    token: 'token',
    payload: 'payload',
  },
} as const;

export type DurableColumnMap = typeof DURABLE_CANONICAL_COLUMNS;

/** A single column-name disagreement found by {@link assertDurableColumns}. */
export interface DurableColumnMismatch {
  table: string;
  property: string;
  expected: string;
  actual: string | undefined;
}

/**
 * Walk every (table, property) in the canonical contract and compare it to what an adapter actually
 * maps, via the supplied `resolve(table, property) => columnName`. Returns the list of mismatches
 * (empty when the adapter is canonical) so a spec can `expect(assertDurableColumns(resolve)).toEqual([])`.
 *
 * Pass `expected = DURABLE_CANONICAL_COLUMNS` (default) for the snake_case contract, or a map of the
 * property names to themselves to assert the camelCase ("preserve") naming.
 */
export function assertDurableColumns(
  resolve: (table: string, property: string) => string | undefined,
  expected: Record<string, Record<string, string>> = DURABLE_CANONICAL_COLUMNS,
): DurableColumnMismatch[] {
  const mismatches: DurableColumnMismatch[] = [];
  for (const [table, props] of Object.entries(expected)) {
    for (const [property, column] of Object.entries(props)) {
      const actual = resolve(table, property);
      if (actual !== column) mismatches.push({ table, property, expected: column, actual });
    }
  }
  return mismatches;
}

/** The "preserve" (camelCase) expectation: every property maps to a column of the same name. */
export function preserveColumnExpectation(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [table, props] of Object.entries(DURABLE_CANONICAL_COLUMNS)) {
    out[table] = Object.fromEntries(Object.keys(props).map((p) => [p, p]));
  }
  return out;
}
