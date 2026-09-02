import type { RunStatus } from '@dudousxd/nestjs-durable-core';
import { BaseFilter, FilterFor, Filterable } from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { parseAttrFilters } from './attr-filter.js';
import { DurableRun } from './durable-run.js';
import type { RunQueryDraft } from './run-query-draft.js';
import { RUN_QUERY_ADAPTER } from './run-query.adapter.js';

/**
 * A repeated query param arrives as an array and a single one as a scalar; both mean a list. An
 * absent or blank entry is dropped rather than stringified: `?namespace=` is what a cleared filter
 * box sends, and `String(undefined)` would filter for a tenant literally named "undefined".
 */
function list(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map(String);
}

/** A bound from the query string. A non-numeric or negative value is treated as absent rather than
 *  coerced to 0, which would return an empty page and read as "there are no runs". */
function bound(value: unknown): number | undefined {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The console's run filter.
 *
 * Every predicate is reachable two ways, and both are the same request to this class: the flat form
 * the console has always sent (`?status=failed&tag=etl`, repeatable for a set) is dispatched to the
 * `@FilterFor` methods below, and the structured form (`filter[where][...]`, what
 * `@dudousxd/nestjs-filter-client`'s `filterQuery()` builds) goes through the adapter's
 * `applyColumnFilters`. Keeping the flat spelling working is not politeness to old callers — it is
 * what lets a run row's tag chip stay a plain link.
 *
 * `autoFields: false`: every key is declared here or refused. The fields exist for a REASON that
 * auto-application cannot know — `tag` is set membership, `origin` has an absent bucket, `attr.*` is
 * typed — and a key silently auto-applied as `equals` would be wrong for three of the five.
 */
@Injectable()
@Filterable({ entity: DurableRun, adapter: RUN_QUERY_ADAPTER, autoFields: false })
export class RunFilter extends BaseFilter<RunQueryDraft> {
  /** One status narrows; several match ANY of them — how a caller asks for a SET (the console's
   *  in-flight sibling query, for one). */
  @FilterFor('status')
  applyStatus(value: unknown): void {
    const values = list(value) as RunStatus[];
    if (values.length === 0) return;
    this.$query.narrow(values.length === 1 ? { status: values[0] } : { statuses: values });
  }

  @FilterFor('workflow')
  applyWorkflow(value: unknown): void {
    const values = list(value);
    if (values.length === 0) return;
    this.$query.narrow(values.length === 1 ? { workflow: values[0] } : { workflows: values });
  }

  /** A blank param (`?namespace=`, from a cleared filter box) is the same as an absent one; passing
   *  `''` through would be an exact match on a tenant nobody has, i.e. a silently empty console. */
  @FilterFor('namespace')
  applyNamespace(value: unknown): void {
    const values = list(value);
    if (values.length === 0) return;
    this.$query.narrow(values.length === 1 ? { namespace: values[0] } : { namespaces: values });
  }

  @FilterFor('tag')
  applyTag(value: unknown): void {
    const values = list(value);
    if (values.length === 0) return;
    this.$query.narrow(values.length === 1 ? { tag: values[0] } : { tags: values });
  }

  /**
   * Origin has THREE states rather than two — a named package, the unattributed bucket, or no
   * restriction — and the bucket rides on its own `unattributed` param rather than on a reserved
   * `origin` value, because any reserved string is a package name someone can legitimately have and a
   * console that quietly reinterpreted it would show the wrong runs.
   *
   * Both keys resolve through one function, called from either, reading the RAW input each time:
   * the answer depends on both params, and `@FilterFor` dispatch follows the order the client's keys
   * happen to arrive in. Recomputing from the input makes the result the same either way, where
   * accumulating onto the draft would make `?origin=x&unattributed=true` mean different things
   * depending on key order.
   *
   * Sent together they are a UNION, not a contradiction: `origins` carries the absent bucket
   * alongside named packages, which is the "this package plus the runs nothing claims" view that a
   * single `origin` value cannot express at all.
   */
  @FilterFor('origin')
  applyOrigin(): void {
    this.resolveOrigin();
  }

  @FilterFor('unattributed')
  applyUnattributed(): void {
    this.resolveOrigin();
  }

  private resolveOrigin(): void {
    const named = list(this.$input.origin);
    const raw = this.$input.unattributed;
    const wantsUnattributed = raw === 'true' || raw === '1' || raw === true;
    const values: Array<string | null> = [...named, ...(wantsUnattributed ? [null] : [])];
    if (values.length === 0) return;
    if (values.length === 1) {
      const only = values[0] as string | null;
      this.$query.narrow({ origin: only });
      return;
    }
    this.$query.narrow({ origins: values });
  }

  /** Comma/repeat-separated `key:op:value` predicates (e.g. `amount:gte:200`), ANDed. The structured
   *  spelling of the same thing is `filter[where][attr.amount][gte]=200`. */
  @FilterFor('attr')
  applyAttributes(value: unknown): void {
    for (const filter of parseAttrFilters(value as string | string[]) ?? []) {
      this.$query.attribute(filter);
    }
  }

  @FilterFor('limit')
  applyLimit(value: unknown): void {
    const limit = bound(value);
    if (limit !== undefined) this.$query.narrow({ limit });
  }

  @FilterFor('offset')
  applyOffset(value: unknown): void {
    const offset = bound(value);
    if (offset !== undefined) this.$query.narrow({ offset });
  }
}
