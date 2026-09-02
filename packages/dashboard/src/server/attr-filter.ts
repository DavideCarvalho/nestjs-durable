import type { AttributeFilter, AttributeOp, AttributeValue } from '@dudousxd/nestjs-durable-core';

const SCALAR_OPS = new Set<AttributeOp>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);

/** Separates the operands of an `in` predicate. `,` already separates whole predicates and `:`
 *  already delimits the parts, so the set needs a third character that neither can be. */
const IN_SEPARATOR = '|';

/** Coerce a query-string value: `true`/`false` → boolean, numeric → number, else the raw string. */
function coerce(v: string): AttributeValue {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/**
 * Parse `attr=key:op:value` query params (repeatable, ANDed) into {@link AttributeFilter}s — e.g.
 * `?attr=amount:gte:200&attr=tier:eq:pro`. `op` must be a known operator; a colon in the value is
 * preserved (only the first two colons delimit). Malformed entries are skipped.
 *
 * `in` takes a `|`-separated SET — `?attr=tier:in:pro|enterprise` — which is the flat spelling of the
 * predicate a multi-select produces. It needs its own operator because two `eq` predicates on one key
 * are ANDed like every other pair, and no run satisfies both.
 */
export function parseAttrFilters(attr?: string | string[]): AttributeFilter[] | undefined {
  if (!attr) return undefined;
  const raw = Array.isArray(attr) ? attr : [attr];
  const filters: AttributeFilter[] = [];
  for (const entry of raw) {
    const [key, op, ...rest] = entry.split(':');
    if (!key || rest.length === 0) continue;
    const operand = rest.join(':');
    if (op === 'in') {
      const values = operand.split(IN_SEPARATOR).filter(Boolean).map(coerce);
      if (values.length) filters.push({ key, op: 'in', values });
      continue;
    }
    if (!SCALAR_OPS.has(op as AttributeOp)) continue;
    filters.push({ key, op: op as Exclude<AttributeOp, 'in'>, value: coerce(operand) });
  }
  return filters.length ? filters : undefined;
}
