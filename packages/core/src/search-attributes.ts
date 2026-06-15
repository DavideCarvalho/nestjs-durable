import type { AttributeFilter, AttributeOp, RunQuery, WorkflowRun } from './interfaces';
import type { SearchAttributes } from './interfaces';

/** Compare one attribute value against a filter operand. Range ops need both sides comparable. */
function compare(actual: unknown, op: AttributeOp, expected: string | number | boolean): boolean {
  switch (op) {
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
  return filters.every((f) => f.key in attributes && compare(attributes[f.key], f.op, f.value));
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
