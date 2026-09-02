import {
  type AttributeOp,
  type AttributeValue,
  RUN_VALUE_FACET_LIMIT,
  RunGateway,
  type RunListItem,
  type RunQuery,
  type RunStatus,
} from '@dudousxd/nestjs-durable-core';
import type {
  ColumnFilter,
  EntityFieldInfo,
  FilterAdapter,
  GroupByCountField,
  SortItem,
} from '@dudousxd/nestjs-filter';
import { BadRequestException, Injectable, type Type } from '@nestjs/common';
import { ATTRIBUTE_FIELD, DURABLE_RUN_FIELDS, DurableRun, runValueAxisFor } from './durable-run.js';
import { RunQueryDraft } from './run-query-draft.js';

/** DI token for {@link RunQueryAdapter} — named on `@Filterable({ adapter })` so the run filter uses
 *  THIS adapter even in a host application whose global filter adapter is its own ORM's. */
export const RUN_QUERY_ADAPTER = Symbol('DURABLE_RUN_QUERY_ADAPTER');

/** The only ordering a run listing has (`createdAt DESC`, newest first), fixed by the store adapters. */
const FIXED_ORDER: SortItem = { field: 'createdAt', direction: 'desc' };

/**
 * Coerce a query-string operand: `true`/`false` → boolean, numeric → number, else the raw string.
 * Search attributes are typed (a `gte` on a number must compare numerically), and a GET route
 * delivers every operand as text.
 */
function coerce(value: unknown): AttributeValue {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const raw = String(value);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/** A filter operand as a list: the `in` family carries an array, every other operator one value. */
function operands(clause: ColumnFilter): unknown[] {
  return Array.isArray(clause.value) ? clause.value : [clause.value];
}

/** The error every unsupported translation raises, naming what was asked and what this backend can
 *  answer — the alternative (dropping the clause) returns a wider result set that reads as success. */
function unsupported(clause: ColumnFilter, supported: string): never {
  throw new BadRequestException(
    `The durable run list cannot filter \`${clause.field}\` with \`${clause.operator}\`. Supported here: ${supported}.`,
  );
}

/**
 * A {@link FilterAdapter} over the durable **run gateway** rather than over an ORM.
 *
 * This is what lets the console's filters be written with `@dudousxd/nestjs-filter` — its wire format,
 * its operator allowlist, its `groupByCount` — while the data still comes from `RunGateway`, and so
 * still works on every store adapter AND on a tenant deployment that has no store at all, only a
 * proxy over the transport.
 *
 * The adapter's "query builder" is a {@link RunQueryDraft} (see it for why), and translation is
 * TOTAL rather than best-effort: `RunQuery` has a fixed set of predicates, so a field/operator pair
 * outside it raises {@link BadRequestException} instead of being ignored. That is the difference
 * between a console that says "I can't filter by that" and one that quietly shows every run.
 */
@Injectable()
export class RunQueryAdapter implements FilterAdapter {
  constructor(private readonly gateway: RunGateway) {}

  createQueryBuilder<E>(entity: Type<E>): unknown {
    this.assertDurableRun(entity);
    return new RunQueryDraft();
  }

  getEntityFields(entity: Type<unknown>): EntityFieldInfo[] | null {
    return entity === DurableRun ? DURABLE_RUN_FIELDS : null;
  }

  /** No relations: a run is a flat row here, and the one nested-looking address (`attr.<key>`) is a
   *  JSON path. Returning `[]` (not null) tells the runner the answer is "none", not "can't say". */
  getEntityRelations(): [] {
    return [];
  }

  /**
   * Which addresses resolve, and as what. `attr` and `attr.<key>` are JSON paths — that classification
   * is what routes a flat `?attr.tier=pro` through the same translation as a structured
   * `where[attr.tier]`, instead of it being dropped as an unknown key.
   */
  resolveFieldPath(entity: Type<unknown>, path: string): 'field' | 'relation' | 'json' | null {
    if (entity !== DurableRun) return null;
    if (path === ATTRIBUTE_FIELD || path.startsWith(`${ATTRIBUTE_FIELD}.`)) return 'json';
    return DURABLE_RUN_FIELDS.some((f) => f.name === path) ? 'field' : null;
  }

  applyColumnFilters(qb: unknown, filters: ColumnFilter[], entity?: Type<unknown>): void {
    if (entity) this.assertDurableRun(entity);
    const draft = this.draft(qb);
    for (const clause of filters) {
      // A run query is a flat AND of named predicates — there is no nesting to put a group INSIDE.
      if (clause.AND || clause.OR) {
        throw new BadRequestException(
          'The durable run list cannot filter with nested AND/OR groups: its predicates are a flat conjunction.',
        );
      }
      this.applyClause(draft, clause);
    }
  }

  private applyClause(draft: RunQueryDraft, clause: ColumnFilter): void {
    const { field, operator } = clause;
    if (field === ATTRIBUTE_FIELD || field.startsWith(`${ATTRIBUTE_FIELD}.`)) {
      this.applyAttributeClause(draft, clause);
      return;
    }
    const anyOf = operator === 'in' || operator === 'isAnyOf';
    switch (field) {
      case 'status':
        if (operator === 'equals') {
          draft.narrow({ status: String(clause.value) as RunStatus });
        } else if (anyOf) {
          draft.narrow({ statuses: operands(clause).map((v) => String(v) as RunStatus) });
        } else {
          unsupported(clause, 'equals, in');
        }
        return;
      case 'workflow':
        if (operator === 'equals') {
          draft.narrow({ workflow: String(clause.value) });
        } else if (anyOf) {
          draft.narrow({ workflows: operands(clause).map(String) });
        } else {
          unsupported(clause, 'equals, in');
        }
        return;
      case 'namespace':
        if (operator === 'equals') {
          draft.narrow({ namespace: String(clause.value) });
        } else if (anyOf) {
          draft.narrow({ namespaces: operands(clause).map(String) });
        } else {
          unsupported(clause, 'equals, in');
        }
        return;
      case 'tag':
        // Membership, not equality with the set — see `DurableRun.tag`.
        if (operator === 'equals') {
          draft.narrow({ tag: String(clause.value) });
        } else if (anyOf) {
          draft.narrow({ tags: operands(clause).map(String) });
        } else {
          unsupported(clause, 'equals, in');
        }
        return;
      case 'origin':
        // `null` is a real value on this axis (the unattributed bucket), so it survives translation
        // instead of being coerced to the string "null".
        if (operator === 'isNull') {
          draft.narrow({ origin: null });
        } else if (operator === 'equals') {
          draft.narrow({ origin: clause.value === null ? null : String(clause.value) });
        } else if (anyOf) {
          draft.narrow({ origins: operands(clause).map((v) => (v === null ? null : String(v))) });
        } else {
          // `isNotNull` is deliberately absent: "any origin at all" is not a predicate `RunQuery`
          // has, and answering it by listing every known origin would silently miss the ones with no
          // runs.
          unsupported(clause, 'equals, in, isNull');
        }
        return;
      default:
        unsupported(clause, `one of ${DURABLE_RUN_FIELDS.map((f) => f.name).join(', ')}`);
    }
  }

  /** `attr.<key>` → one {@link AttributeFilter}. The operator set is the store's, so the mapping is
   *  1:1 and anything outside it is rejected rather than approximated. */
  private applyAttributeClause(draft: RunQueryDraft, clause: ColumnFilter): void {
    const key = clause.field.slice(ATTRIBUTE_FIELD.length + 1);
    if (!key) {
      throw new BadRequestException(
        'Filtering search attributes needs a key: `attr.<key>`, e.g. `attr.tier`.',
      );
    }
    const scalarOps: Record<string, Exclude<AttributeOp, 'in'>> = {
      equals: 'eq',
      notEquals: 'ne',
      gt: 'gt',
      gte: 'gte',
      lt: 'lt',
      lte: 'lte',
    };
    const scalar = scalarOps[clause.operator as string];
    if (scalar) {
      draft.attribute({ key, op: scalar, value: coerce(clause.value) });
      return;
    }
    if (clause.operator === 'in' || clause.operator === 'isAnyOf') {
      draft.attribute({ key, op: 'in', values: operands(clause).map(coerce) });
      return;
    }
    unsupported(clause, 'equals, notEquals, gt, gte, lt, lte, in');
  }

  applyOffsetPagination(qb: unknown, page: number, size: number): void {
    this.draft(qb).narrow({ limit: size, offset: (page - 1) * size });
  }

  /**
   * A run listing has ONE order — newest first — because that is what every store adapter's
   * `listRuns` emits and what the console's paging depends on. A request for any other sort is
   * refused rather than accepted and ignored: silently returning a differently-ordered page is how a
   * paginated list starts duplicating and skipping rows.
   */
  applySort(_qb: unknown, sorts: SortItem[]): void {
    for (const sort of sorts) {
      if (sort.field !== FIXED_ORDER.field || sort.direction !== FIXED_ORDER.direction) {
        throw new BadRequestException(
          `The durable run list is always ordered \`${FIXED_ORDER.field} ${FIXED_ORDER.direction}\` and cannot be sorted by \`${sort.field} ${sort.direction}\`.`,
        );
      }
    }
  }

  getResult(qb: unknown): Promise<RunListItem[]> {
    return this.gateway.listRuns(this.draft(qb).query);
  }

  /**
   * A page plus the size of the whole matching set. The total comes from the facet aggregate rather
   * than from a second listing — that is the entire reason durable exposes one, and it keeps the
   * count exact while the page stays bounded.
   */
  async getResultAndCount(qb: unknown): Promise<{ rows: unknown[]; total: number }> {
    const draft = this.draft(qb);
    const [rows, facets] = await Promise.all([
      this.gateway.listRuns(draft.query),
      this.gateway.runFacets(draft.facetQuery()),
    ]);
    const { status, statuses, origin, origins } = draft.query;
    const total = facets
      .filter((cell) => {
        if (status && cell.status !== status) return false;
        if (statuses && !statuses.includes(cell.status)) return false;
        if (origin !== undefined && cell.origin !== origin) return false;
        if (origins && !origins.includes(cell.origin)) return false;
        return true;
      })
      .reduce((sum, cell) => sum + cell.count, 0);
    return { rows, total };
  }

  /**
   * The distinct values of one field over the runs the active predicates select — the console's
   * pickers. `limit` is honoured because it has to be: tag and search-attribute cardinality grows
   * with the data, so the unbounded answer is a listing rather than an aggregate.
   */
  async groupByCount(
    qb: unknown,
    field: GroupByCountField,
    entity: Type<unknown>,
    opts?: { bucket?: number; limit?: number },
  ): Promise<Array<{ value: unknown; count: number }>> {
    this.assertDurableRun(entity);
    if (typeof field !== 'string') {
      throw new BadRequestException(
        'The durable run list has no computed fields to group by — group by one of its own fields.',
      );
    }
    if (opts?.bucket !== undefined) {
      throw new BadRequestException(
        'The durable run list cannot bucket a group-by-count: none of its filterable fields is numeric.',
      );
    }
    const axis = runValueAxisFor(field);
    if (!axis) {
      throw new BadRequestException(
        `The durable run list cannot enumerate values of \`${field}\`.`,
      );
    }
    const rows = await this.gateway.runValueFacets(axis, this.draft(qb).facetQuery(), {
      limit: opts?.limit ?? RUN_VALUE_FACET_LIMIT,
    });
    return rows.map((row) => ({ value: row.value, count: row.count }));
  }

  getPrimaryKey(): string {
    return 'id';
  }

  private draft(qb: unknown): RunQueryDraft {
    if (!(qb instanceof RunQueryDraft)) {
      throw new Error(
        'The durable run adapter was handed a query builder it did not create. A filter using it must declare `@Filterable({ entity: DurableRun, adapter: RUN_QUERY_ADAPTER })`.',
      );
    }
    return qb;
  }

  private assertDurableRun(entity: Type<unknown>): void {
    if (entity !== DurableRun) {
      throw new Error(
        `The durable run adapter only answers for DurableRun, not ${entity?.name ?? String(entity)}.`,
      );
    }
  }
}

/** Re-exported for a host that wants to narrow the query itself (see `RunQueryDraft`). */
export type { RunQuery };
