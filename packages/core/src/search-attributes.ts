import type {
  AttributeFilter,
  AttributeOp,
  RunQuery,
  ScalarAttributeFilter,
  WorkflowRun,
} from './interfaces';
import type { SearchAttributes } from './interfaces';

/** Compare one attribute value against a predicate. Range ops need both sides comparable; `in` is an
 *  OR over its operand set, so an empty set matches nothing. */
function compare(actual: unknown, filter: AttributeFilter): boolean {
  if (filter.op === 'in') return filter.values.some((v) => actual === v);
  const expected = filter.value;
  switch (filter.op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return actual != null && actual > expected;
    case 'gte':
      return actual != null && actual >= expected;
    case 'lt':
      return actual != null && actual < expected;
    case 'lte':
      return actual != null && actual <= expected;
  }
}

/**
 * Does a run's search attributes satisfy EVERY filter (AND)? A missing key never matches (so `ne`
 * on an absent key is false too — the attribute simply isn't there to compare). Empty/undefined
 * filters match everything. Shared by every store so typed/range queries behave identically across
 * adapters (applied in-process after the coarse workflow/status/tag filters).
 */
export function matchesAttributes(
  attributes: SearchAttributes | undefined,
  filters: AttributeFilter[] | undefined,
): boolean {
  if (!filters?.length) return true;
  if (!attributes) return false;
  return filters.every((f) => f.key in attributes && compare(attributes[f.key], f));
}

/**
 * Apply a query's attribute predicates then its `offset`/`limit`, in-process — for store adapters
 * that can't express typed/range predicates in SQL. Pass rows already coarse-filtered (workflow /
 * status / tag) and sorted newest-first; this filters by `attributes` and paginates. Only call it
 * when `query.attributes` is set (otherwise let the DB do `LIMIT`/`OFFSET`).
 */
export function applyAttributeQuery(rows: WorkflowRun[], query: RunQuery): WorkflowRun[] {
  const filtered = rows.filter((r) => matchesAttributes(r.searchAttributes, query.attributes));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? filtered.length;
  return filtered.slice(offset, offset + limit);
}

/**
 * One normalized row of the `durable_run_attributes` side-table: a single (key → value) pair of a
 * run's search attributes, split into typed columns so SQL can index/range-scan it. Exactly one of
 * `strValue`/`numValue` is set per row (booleans normalize to a string `"true"`/`"false"` so `eq`/`ne`
 * still match). NULL for the column that doesn't apply, which keeps `(key, numValue)` /
 * `(key, strValue)` indexes selective.
 */
export interface RunAttributeRow {
  runId: string;
  key: string;
  strValue: string | null;
  numValue: number | null;
}

/**
 * Explode a run's search attributes into normalized side-table rows (one per key). Used by SQL stores
 * to maintain `durable_run_attributes` on every create/update and by the in-memory store's index, so
 * attribute predicates can be pushed DOWN into a join/EXISTS instead of scanned in-process. Numbers go
 * to `numValue`; strings to `strValue`; booleans to `strValue` as `"true"`/`"false"` (matching how the
 * in-process `compare` treats `eq`/`ne` on booleans). Returns `[]` for a run with no attributes.
 */
export function normalizeAttributeRows(
  runId: string,
  attributes: SearchAttributes | undefined,
): RunAttributeRow[] {
  if (!attributes) return [];
  const out: RunAttributeRow[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'number') {
      out.push({ runId, key, strValue: null, numValue: value });
    } else if (typeof value === 'boolean') {
      out.push({ runId, key, strValue: value ? 'true' : 'false', numValue: null });
    } else {
      out.push({ runId, key, strValue: value, numValue: null });
    }
  }
  return out;
}

/**
 * SQL comparison operator for a single-operand {@link AttributeOp} (used to build pushdown
 * predicates). `in` is absent by construction: it compares against a SET, which a store emits as an
 * OR of equalities over {@link attributePredicateOperands} rather than as one comparator.
 */
export function sqlComparator(op: Exclude<AttributeOp, 'in'>): string {
  switch (op) {
    case 'eq':
      return '=';
    case 'ne':
      return '<>';
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
  }
}

/**
 * Which side-table column an attribute filter compares against: numeric operands (and range ops on
 * numbers) hit `numValue`; everything else hits `strValue` (booleans are stored as `"true"`/`"false"`).
 * Keeping this in core means every SQL adapter pushes predicates down identically.
 */
export function attributeColumnFor(filter: ScalarAttributeFilter): 'numValue' | 'strValue' {
  return typeof filter.value === 'number' ? 'numValue' : 'strValue';
}

/** The literal a side-table predicate compares against (booleans → `"true"`/`"false"` strings). */
export function attributeOperand(filter: ScalarAttributeFilter): string | number {
  if (typeof filter.value === 'boolean') return filter.value ? 'true' : 'false';
  return filter.value;
}

/** One comparison a side-table predicate makes: which typed column, with which operator, against
 *  which literal. */
export interface AttributePredicateOperand {
  column: 'numValue' | 'strValue';
  comparator: string;
  operand: string | number;
}

/**
 * The comparisons one {@link AttributeFilter} makes, for a store to OR together inside its
 * `EXISTS`/join on the normalized attribute side-table. A scalar op yields exactly ONE comparison
 * (the same column/operator/literal {@link attributeColumnFor} and {@link attributeOperand} give);
 * `in` yields one per member, each an equality, since its operands may be of mixed types and so land
 * in different typed columns.
 *
 * An EMPTY list is a real answer, not a missing one: `in` over no values can match no run. A caller
 * that ORs an empty list must emit a false predicate rather than dropping the filter, or the query
 * silently widens to every run.
 */
export function attributePredicateOperands(filter: AttributeFilter): AttributePredicateOperand[] {
  if (filter.op === 'in') {
    return filter.values.map((value) => {
      const scalar = { key: filter.key, op: 'eq', value } as ScalarAttributeFilter;
      return {
        column: attributeColumnFor(scalar),
        comparator: '=',
        operand: attributeOperand(scalar),
      };
    });
  }
  return [
    {
      column: attributeColumnFor(filter),
      comparator: sqlComparator(filter.op),
      operand: attributeOperand(filter),
    },
  ];
}
