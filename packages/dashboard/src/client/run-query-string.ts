import type { RunStatus } from '@dudousxd/nestjs-durable-core';
import { flatObjectToQueryString } from '@dudousxd/nestjs-filter-client';

/** The fields a value picker can enumerate. `attr` lists the search-attribute KEYS in use;
 *  `attr.<key>` lists the values recorded under one of them. */
export type RunValueField =
  | 'workflow'
  | 'status'
  | 'origin'
  | 'namespace'
  | 'tag'
  | `attr.${string}`
  | 'attr';

/** One row of a value picker: a distinct value and how many matching runs carry it. `null` only for
 *  the axis that has an absent bucket (a run with no origin). */
export interface RunValueRow {
  value: string | null;
  count: number;
}

/**
 * Everything the console can narrow a run listing by. A scalar narrows to one value; an ARRAY
 * matches any of them, which is what a multi-select produces.
 */
export interface RunPredicates {
  status?: RunStatus | RunStatus[] | undefined;
  workflow?: string | string[] | undefined;
  tag?: string | string[] | undefined;
  namespace?: string | string[] | undefined;
  /** A package name, or `null` for the unattributed bucket — a run with no origin matches no origin
   *  VALUE at all, so absence needs its own spelling. */
  origin?: string | null | undefined;
  /** `key:op:value` predicates (`amount:gte:200`), or `key:in:a|b` for a set. Sent as
   *  `filter[attr.<key>][op]=value`. */
  attr?: string[] | undefined;
}

/** The search-attribute ops the server accepts on `filter[attr.<key>][op]`. Anything else is not a
 *  predicate the run store can answer, so it is not sent. */
const ATTR_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']);

/** Paging of a run listing: `page` is 1-based, `size` is capped by the server (500). */
export interface RunPage {
  page?: number | undefined;
  size?: number | undefined;
}

/**
 * The console's filter as a query string, in Aviary's list wire (`filter[status]=failed`,
 * `filter[tag][]=etl&filter[tag][]=nightly`, `filter[attr.amount][gte]=200`,
 * `filter[unattributed]=true`), serialized with `@dudousxd/nestjs-filter-client`.
 *
 * One builder for the listing, its facet counts, its value pickers and its bulk actions, so those
 * four can never disagree about what the operator selected — a bulk retry scoped more widely than
 * the list it was launched from acts on runs nobody looked at.
 */
export function runQueryString(
  predicates: RunPredicates,
  paging: RunPage = {},
  groupByCount?: { field: RunValueField; limit?: number; offset?: number; search?: string },
): string {
  const filter: Record<string, unknown> = {};
  const narrow = (field: string, value: string | string[] | undefined): void => {
    if (value === undefined) return;
    const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== '');
    // An empty selection is "no restriction", not "match nothing": the operator cleared the box. A
    // blank value is what a cleared box sends, and passing it would match a value nothing has.
    if (values.length === 0) return;
    // A single value goes bare unless it holds a comma, which the bare form reads as a list.
    filter[field] = values.length === 1 && !values[0]?.includes(',') ? values[0] : values;
  };

  narrow('status', predicates.status);
  narrow('workflow', predicates.workflow);
  narrow('tag', predicates.tag);
  narrow('namespace', predicates.namespace);
  // `null` is the unattributed bucket — a run with no origin matches no origin VALUE at all.
  if (predicates.origin === null) filter.unattributed = 'true';
  else if (predicates.origin) filter.origin = predicates.origin;

  for (const entry of predicates.attr ?? []) {
    const [key, op, ...rest] = entry.split(':');
    if (!key || !op || !ATTR_OPERATORS.has(op) || rest.length === 0) continue;
    const operand = rest.join(':');
    const field = `attr.${key}`;
    const ops = (filter[field] ?? {}) as Record<string, string>;
    ops[op] = op === 'in' ? operand.split('|').filter(Boolean).join(',') : operand;
    filter[field] = ops;
  }

  const parts = [flatObjectToQueryString(filter, { prefix: 'filter' })];
  if (paging.page !== undefined) parts.push(`page=${paging.page}`);
  if (paging.size !== undefined) parts.push(`size=${paging.size}`);
  if (groupByCount) {
    parts.push(flatObjectToQueryString(groupByCount, { prefix: 'groupByCount' }));
  }
  return parts.filter(Boolean).join('&');
}
