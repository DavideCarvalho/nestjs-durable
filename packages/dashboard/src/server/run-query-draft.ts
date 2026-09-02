import type { AttributeFilter, RunFacetQuery, RunQuery } from '@dudousxd/nestjs-durable-core';

/**
 * What this adapter hands the filter runner in place of a query builder: a {@link RunQuery} under
 * construction.
 *
 * The runner never inspects it — it only passes it back to the adapter's own methods — so the shape
 * is ours to choose, and a plain predicate bag is the honest one. There is no SQL to append to here;
 * a run query is a fixed set of named predicates that the gateway resolves, so "building" it is
 * filling fields in, and everything the filter lib can express but `RunQuery` cannot is rejected at
 * the point of translation rather than accumulated and silently dropped.
 */
export class RunQueryDraft {
  readonly query: RunQuery = {};

  /** Narrow by one or more predicates. Later calls overwrite the same field — the runner applies one
   *  clause per field, so the last one wins, exactly as a repeated `where` on a builder would. */
  narrow(patch: RunQuery): void {
    Object.assign(this.query, patch);
  }

  /** Add one search-attribute predicate. These ACCUMULATE (unlike {@link narrow}) because
   *  `RunQuery.attributes` is an ANDed list — two predicates on different keys are both meant. */
  attribute(filter: AttributeFilter): void {
    this.query.attributes = [...(this.query.attributes ?? []), filter];
  }

  /** The predicates minus the page window and the axes a facet count reports on — what
   *  `runFacets`/`runValueFacets` are taken over. */
  facetQuery(): RunFacetQuery {
    const { status, statuses, origin, origins, limit, offset, ...facetQuery } = this.query;
    return facetQuery;
  }
}
