import type { ColumnFilter } from '@dudousxd/nestjs-filter';
import { ATTRIBUTE_FIELD } from './durable-run.js';
import { ListQueryError, parseFilterParams, parsePageParams, resolveSort } from './list-api.js';

/** A run page holds this many rows when the request sends no `size`. */
export const RUN_PAGE_SIZE = 100;
/** The largest run page a request may ask for; a bigger `size` is clamped to it. */
export const RUN_PAGE_MAX = 500;

/** The operators each run filter field accepts on the wire (`filter[field][op]=v`). */
const RUN_FIELDS = {
  status: ['eq', 'in'],
  workflow: ['eq', 'in'],
  namespace: ['eq', 'in'],
  /** Membership: `filter[tag]=etl` is the runs CARRYING `etl`, not runs whose tags equal it. */
  tag: ['eq', 'in'],
  origin: ['eq', 'in'],
  /**
   * The runs no package claims. A field of its own rather than an `origin` value: any reserved
   * string is a package name someone can legitimately have. Sent with `origin` it is a UNION — "this
   * package plus the runs nothing claims" — which no single origin predicate can express.
   */
  unattributed: ['eq'],
} as const;

/** The operators a search attribute (`filter[attr.<key>][op]=v`) accepts — the store's own set. */
const ATTRIBUTE_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'] as const;

/** Wire operator → `@dudousxd/nestjs-filter` column operator. */
const COLUMN_OPERATOR: Record<string, string> = {
  eq: 'equals',
  ne: 'notEquals',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  in: 'in',
};

/** `filter[attr.<key>]...` keys of the request, in both the nested and the flat query shape. */
function attributeFields(query: Record<string, unknown>): string[] {
  const fields = new Set<string>();
  const nested = query.filter;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const key of Object.keys(nested)) {
      if (key.startsWith(`${ATTRIBUTE_FIELD}.`) && key.length > ATTRIBUTE_FIELD.length + 1) {
        fields.add(key);
      }
    }
  }
  for (const key of Object.keys(query)) {
    const match = /^filter\[(attr\.[^[\]]+)\]/.exec(key);
    if (match?.[1]) fields.add(match[1]);
  }
  return [...fields];
}

function readBoolean(field: string, value: string | string[]): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ListQueryError(`Invalid filter: "filter[${field}]" must be true or false.`);
}

/**
 * The `filter[...]` params of a run request as `@dudousxd/nestjs-filter` column filters, for
 * `RunFilter` to apply through `RunQueryAdapter`.
 *
 * The wire is Aviary's list API: `filter[status]=failed`, `filter[status]=failed,dead` or
 * `filter[status][in]=failed,dead` for a set, `filter[attr.amount][gte]=200` for a search
 * attribute, `filter[unattributed]=true` for the runs with no origin. An unknown field or an
 * operator the field does not take is a 400 ({@link ListQueryError}), never a wider result set.
 */
export function runColumnFilters(query: Record<string, unknown>): ColumnFilter[] {
  const fields: Record<string, readonly string[]> = { ...RUN_FIELDS };
  for (const field of attributeFields(query)) fields[field] = ATTRIBUTE_OPS;
  const parsed = parseFilterParams(query, { fields });

  const where: ColumnFilter[] = [];
  const origins: string[] = [];
  let unattributed = false;
  for (const { field, op, value } of parsed) {
    if (field === 'unattributed') {
      unattributed = readBoolean(field, value);
      continue;
    }
    if (field === 'origin') {
      origins.push(...(Array.isArray(value) ? value : [value]));
      continue;
    }
    where.push({
      field,
      operator: COLUMN_OPERATOR[op] as ColumnFilter['operator'],
      value,
    } as ColumnFilter);
  }
  // Origin is resolved once, after every param is read: the answer depends on both `origin` and
  // `unattributed`, and must not depend on the order the client's keys arrived in.
  if (unattributed && origins.length === 0) {
    where.push({ field: 'origin', operator: 'isNull' } as ColumnFilter);
  } else if (unattributed || origins.length > 1) {
    where.push({
      field: 'origin',
      operator: 'in',
      value: [...origins, ...(unattributed ? [null] : [])],
    } as ColumnFilter);
  } else if (origins.length === 1) {
    where.push({ field: 'origin', operator: 'equals', value: origins[0] } as ColumnFilter);
  }
  return where;
}

/**
 * The request as `@dudousxd/nestjs-filter` structured input: the filter params translated by
 * {@link runColumnFilters}, every other key (e.g. `groupByCount[...]`) passed through as sent.
 */
export function runFilterInput(query: Record<string, unknown>): Record<string, unknown> {
  const where = runColumnFilters(query);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === 'filter' || key.startsWith('filter[')) continue;
    rest[key] = value;
  }
  return { ...rest, filter: { where } };
}

/**
 * The page window of a run listing. A run listing has one order, newest first, so `sort` accepts
 * only `-createdAt` (and absence); anything else is a 400 rather than a page in another order.
 */
export function runPageParams(query: Record<string, unknown>): {
  page: number;
  size: number;
  offset: number;
} {
  const sort = resolveSort(query.sort, { sortable: ['createdAt'], default: '-createdAt' });
  if (sort.some((item) => item.direction !== 'desc')) {
    throw new ListQueryError(
      'The durable run list is always ordered newest first: sort accepts only "-createdAt".',
    );
  }
  return parsePageParams(query, { defaultSize: RUN_PAGE_SIZE, maxSize: RUN_PAGE_MAX });
}
