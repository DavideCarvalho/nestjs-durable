import type { RunStatus, RunValueAxis, SearchAttributes } from '@dudousxd/nestjs-durable-core';
import type { EntityFieldInfo } from '@dudousxd/nestjs-filter';

/**
 * The filterable surface of a run, declared as a class because that is the shape `@dudousxd/nestjs-filter`
 * works in: `@Filterable({ entity })`, its field validation and its codegen all key off a constructor.
 * Nothing ever instantiates it — the console has no ORM entity to point at, its rows come from the
 * `RunGateway` — so this stands in for one and carries the field list.
 *
 * It declares ONLY what {@link RunQuery} can filter by. That is the load-bearing part: a field absent
 * here is rejected by the runner before it reaches the adapter, which lets the adapter fail loudly on
 * the field/operator combinations it cannot express rather than dropping them into a query that comes
 * back looking successful.
 */
export class DurableRun {
  workflow!: string;
  status!: RunStatus;
  /** `null` for a run no package claims — see `WorkflowRun.origin`. */
  origin!: string | null;
  /** Tenant / worker-pool partition. */
  namespace!: string;
  /**
   * ONE of the run's tags. Singular deliberately: a run carries a SET of tags, so a predicate here
   * asks about membership (`tag in [etl, nightly]` = runs carrying either), never equality with the
   * whole set.
   */
  tag!: string;
  /** Typed search attributes, addressed per key as `attr.<key>` — a JSON sub-path, not a column. */
  attr!: SearchAttributes;
}

/** The `attr` head segment, which the adapter resolves as a JSON path rather than a column. */
export const ATTRIBUTE_FIELD = 'attr';

/**
 * What the filter runner validates client field names against. `columnName` is cosmetic here (there
 * is no SQL behind this adapter) but the `type` is not: it is what lets the runner tell a JSON
 * sub-path from a typo, and so what makes `attr.tier` resolve while `status.tier` stays unknown.
 */
export const DURABLE_RUN_FIELDS: EntityFieldInfo[] = [
  { name: 'workflow', columnName: 'workflow', type: 'string' },
  { name: 'status', columnName: 'status', type: 'string' },
  { name: 'origin', columnName: 'origin', type: 'string' },
  { name: 'namespace', columnName: 'namespace', type: 'string' },
  { name: 'tag', columnName: 'tags', type: 'string' },
  { name: ATTRIBUTE_FIELD, columnName: 'search_attributes', type: 'json' },
];

/**
 * The value axis a filter FIELD enumerates, or `null` for a field with no enumerable values.
 *
 * This is the join between the two libraries: the filter lib's `groupByCount('namespace')` asks
 * "what values does this field take", and durable answers it with `runValueFacets`. `attr` alone
 * lists the search-attribute KEYS in use; `attr.<key>` lists the values recorded under one of them.
 */
export function runValueAxisFor(field: string): RunValueAxis | null {
  if (field === ATTRIBUTE_FIELD) return { field: 'attributeKey' };
  if (field.startsWith(`${ATTRIBUTE_FIELD}.`)) {
    const key = field.slice(ATTRIBUTE_FIELD.length + 1);
    return key ? { field: 'attributeValue', key } : null;
  }
  if (
    field === 'workflow' ||
    field === 'status' ||
    field === 'origin' ||
    field === 'namespace' ||
    field === 'tag'
  ) {
    return { field };
  }
  return null;
}
