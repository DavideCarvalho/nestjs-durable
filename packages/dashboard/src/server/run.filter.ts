import { BaseFilter, Filterable } from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { DurableRun } from './durable-run.js';
import type { RunQueryDraft } from './run-query-draft.js';
import { RUN_QUERY_ADAPTER } from './run-query.adapter.js';

/**
 * The console's run filter.
 *
 * A request's `filter[...]` params (Aviary's list wire: `filter[status]=failed`,
 * `filter[tag][in]=etl,nightly`, `filter[attr.amount][gte]=200`, `filter[unattributed]=true`) are
 * validated and turned into structured `where` clauses by `runColumnFilters`, and this class applies
 * them through `RunQueryAdapter`, which translates each clause into a `RunQuery` predicate or
 * refuses it by name.
 *
 * `autoFields: false`: no key is applied without a translation. The fields exist for a REASON that
 * auto-application cannot know — `tag` is set membership, `origin` has an absent bucket, `attr.*` is
 * typed — and a key silently auto-applied as `equals` would be wrong for three of the five.
 */
@Injectable()
@Filterable({ entity: DurableRun, adapter: RUN_QUERY_ADAPTER, autoFields: false })
export class RunFilter extends BaseFilter<RunQueryDraft> {}
