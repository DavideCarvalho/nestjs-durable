/**
 * Tenancy: the CUSTOMER (organization, clinic, account…) a run belongs to. Not the worker-pool
 * `namespace`, and not the `topology: 'tenant'` process role — those are operator axes; this one is
 * the data owner, read from the request's context (`@dudousxd/nestjs-context`'s tenant).
 *
 * Core never reads a context itself. The host (the NestJS module) hands the engine an
 * {@link EngineTenancy} built from the context accessor; without one, tenancy is off and nothing here
 * changes behaviour.
 */

/** The tenant stamped on a run or schedule row (`tenant_id`, `tenant_kind`). */
export interface RunTenant {
  id: string;
  /** e.g. `organization`, `user`, `clinic`. Absent when the source did not say. */
  kind?: string | undefined;
}

/**
 * Who is asking, for the matching rule:
 * - `system`: no request (pollers, recovery, boot) — sees every row.
 * - `all`: an explicit cross-tenant scope (`Context.allTenants`) — sees every row.
 * - `tenantless`: a request with no tenant — sees only rows with no tenant.
 * - `tenant`: a request for `tenantId` — sees its own rows, plus rows with no tenant when
 *   `nullRows: 'shared'`.
 */
export type TenantFilter =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenantId: string; nullRows?: 'tenantless' | 'shared' | undefined };

/**
 * The seam the host gives the engine to stamp, filter and restore the tenant. Every method is read
 * at call time, so it always reflects the CURRENT async context.
 */
export interface EngineTenancy {
  /** The tenant to stamp on a run/schedule created now (no explicit `tenantId`), or undefined. */
  current(): RunTenant | undefined;
  /** The matching filter for an app-facing read or control call made now. */
  filter(): TenantFilter;
  /** Run `fn` with `tenant` restored as the ambient context tenant. */
  run<T>(tenant: RunTenant, fn: () => T): T;
}

/** A row that may carry a tenant (a run, a schedule). */
export interface TenantRow {
  tenantId?: string | null | undefined;
}

/** True when `filter` may see `row` (Agora tenancy spec §4). */
export function tenantVisible(row: TenantRow, filter: TenantFilter): boolean {
  const id = row.tenantId ?? null;
  switch (filter.mode) {
    case 'system':
    case 'all':
      return true;
    case 'tenantless':
      return id === null;
    case 'tenant':
      return id === filter.tenantId || (id === null && filter.nullRows === 'shared');
  }
}

/**
 * The `tenant_id` values `filter` may see, as a `tenantIds` predicate (`null` = no tenant), or
 * `undefined` when it sees everything.
 */
export function tenantIdsFor(filter: TenantFilter): Array<string | null> | undefined {
  switch (filter.mode) {
    case 'system':
    case 'all':
      return undefined;
    case 'tenantless':
      return [null];
    case 'tenant':
      return filter.nullRows === 'shared' ? [filter.tenantId, null] : [filter.tenantId];
  }
}

/**
 * Narrow a query carrying `tenantIds` to what `filter` may see. An existing `tenantIds` is
 * intersected (never widened); a concurrent single `tenantId` is left in place (stores AND it).
 */
export function scopeTenantQuery<Q extends { tenantIds?: Array<string | null> | undefined }>(
  query: Q,
  filter: TenantFilter,
): Q {
  const allowed = tenantIdsFor(filter);
  if (allowed === undefined) return query;
  const tenantIds = query.tenantIds
    ? query.tenantIds.filter((id) => allowed.includes(id))
    : allowed;
  return { ...query, tenantIds };
}

/** The tenant columns of a row, as a {@link RunTenant}, or undefined when it has none. */
export function rowTenant(row: {
  tenantId?: string | null | undefined;
  tenantKind?: string | null | undefined;
}): RunTenant | undefined {
  if (row.tenantId == null) return undefined;
  return row.tenantKind != null ? { id: row.tenantId, kind: row.tenantKind } : { id: row.tenantId };
}

/** `StartOptions` that make a new run inherit `row`'s tenant (or none, explicitly). */
export function inheritTenant(row: {
  tenantId?: string | null | undefined;
  tenantKind?: string | null | undefined;
}): { tenantId: string | null; tenantKind?: string | undefined } {
  return row.tenantId == null
    ? { tenantId: null }
    : { tenantId: row.tenantId, ...(row.tenantKind != null ? { tenantKind: row.tenantKind } : {}) };
}

/** Does a row match the `tenantId` / `tenantIds` predicates of a query (in-memory stores)? */
export function matchesTenantPredicates(
  row: TenantRow,
  query: { tenantId?: string | null | undefined; tenantIds?: Array<string | null> | undefined },
): boolean {
  const id = row.tenantId ?? null;
  if (query.tenantId !== undefined && id !== query.tenantId) return false;
  if (query.tenantIds !== undefined && !query.tenantIds.includes(id)) return false;
  return true;
}
