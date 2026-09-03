import type { RunStatus } from '@dudousxd/nestjs-durable-core';
import { filterQuery, filterQueryToQueryString } from '@dudousxd/nestjs-filter-client';

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
  /** `key:op:value` predicates (`amount:gte:200`), or `key:in:a|b` for a set. */
  attr?: string[] | undefined;
}

/** The filter operator each search-attribute op maps to. Same set the server accepts; anything else
 *  is not a predicate the run store can answer. */
const ATTR_OPERATORS: Record<string, string> = {
  eq: 'equals',
  ne: 'notEquals',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  in: 'in',
};

/** Coerce an operand the way the server does, so a numeric attribute compares as a number. */
function coerce(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/**
 * The console's filter as a query string, built with `@dudousxd/nestjs-filter-client`.
 *
 * One builder for the listing, its facet counts, its value pickers and its bulk actions, so those
 * four can never disagree about what the operator selected — a bulk retry scoped more widely than
 * the list it was launched from acts on runs nobody looked at.
 *
 * The page bound rides INSIDE the filter envelope (`filter[limit]`) rather than as `paginate`: the
 * console's "show more" grows one window instead of stepping through pages, and `paginate.size` is
 * capped by the server's `maxPageSize` — a cap that would silently stop "show more" at 100 rows.
 */
export function runQueryString(
  predicates: RunPredicates,
  page: { limit?: number | undefined; offset?: number | undefined } = {},
  groupByCount?: { field: RunValueField; limit?: number; offset?: number; search?: string },
): string {
  const query = filterQuery();
  const narrow = (field: string, value: string | string[] | undefined): void => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      // An empty selection is "no restriction", not "match nothing": the operator cleared the box.
      if (value.length === 0) return;
      if (value.length === 1) query.where(field, 'equals', value[0]);
      else query.where(field, 'in', value);
      return;
    }
    // A blank param is what a cleared filter box sends; passing it through would be an exact match
    // on a value nothing has, i.e. a console that goes empty for no visible reason.
    if (value !== '') query.where(field, 'equals', value);
  };

  narrow('status', predicates.status);
  narrow('workflow', predicates.workflow);
  narrow('tag', predicates.tag);
  narrow('namespace', predicates.namespace);
  // `null` is the unattributed bucket — `isNull` is the only operator that can select an absence.
  if (predicates.origin === null) query.where('origin', 'isNull', true);
  else if (predicates.origin) query.where('origin', 'equals', predicates.origin);

  for (const entry of predicates.attr ?? []) {
    const [key, op, ...rest] = entry.split(':');
    const operator = op ? ATTR_OPERATORS[op] : undefined;
    if (!key || !operator || rest.length === 0) continue;
    const operand = rest.join(':');
    query.where(
      `attr.${key}`,
      operator as 'equals',
      op === 'in' ? operand.split('|').filter(Boolean).map(coerce) : coerce(operand),
    );
  }

  const built = query.build();
  return filterQueryToQueryString({
    ...built,
    filter: {
      ...built.filter,
      ...(page.limit !== undefined && { limit: page.limit }),
      ...(page.offset !== undefined && { offset: page.offset }),
    },
    ...(groupByCount && { groupByCount }),
  });
}
