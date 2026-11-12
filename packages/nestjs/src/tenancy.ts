import type { EngineTenancy, RunTenant, TenantFilter } from '@dudousxd/nestjs-durable-core';
import type { ContextAccessor, TenantFilter as ContextTenantFilter } from './context-accessor';

/**
 * Tenancy for durable: the CUSTOMER a run belongs to (`@dudousxd/nestjs-context`'s tenant), not the
 * worker-pool `namespace`. A local, structural reader of the context contract — durable never imports
 * nestjs-context, so it works with any context version or none at all: with the accessor (or its
 * tenancy methods) missing, tenancy reads as off and durable behaves exactly as without it.
 */

/** The `tenancy` option of `DurableModule`. Same shape in every Aviary lib. */
export type DurableTenancyOption =
  | 'inherit'
  | false
  | {
      /** `'inherit'` (default) follows `ContextModule`'s `tenancy.enabled`. */
      enabled?: 'inherit' | boolean;
      /** Tenant kinds durable honours, instead of the context's own `kinds`. */
      kinds?: string[];
      /** Whether a tenant request also sees runs with no tenant. Default `'tenantless'` (it does not). */
      nullRows?: 'tenantless' | 'shared';
    };

type Tenancy =
  | { enabled: false }
  | { enabled: true; nullRows: 'tenantless' | 'shared'; filter(): ContextTenantFilter };

const SLOT = Symbol.for('@dudousxd/nestjs-diagnostics:accessor');

/** The bound accessor, else the one nestjs-context publishes on the global slot, else none. */
function accessorOf(accessor: ContextAccessor | undefined): ContextAccessor | undefined {
  if (accessor) return accessor;
  const slot = (globalThis as unknown as Record<symbol, { current?: unknown } | undefined>)[SLOT];
  return (slot?.current ?? undefined) as ContextAccessor | undefined;
}

/** Read tenancy for one operation (call per operation, never once at boot). */
export function readTenancy(
  option: DurableTenancyOption | undefined,
  accessor: ContextAccessor | undefined,
): Tenancy {
  const a = accessorOf(accessor);
  if (
    option === false ||
    typeof a?.tenancy !== 'function' ||
    typeof a.tenantFilter !== 'function'
  ) {
    return { enabled: false };
  }
  const own = typeof option === 'object' ? option : {};
  const inherit = own.enabled === undefined || own.enabled === 'inherit';
  if (!(inherit ? a.tenancy().enabled : own.enabled)) return { enabled: false };
  const kinds = own.kinds;
  const tenantFilter = a.tenantFilter.bind(a);
  return {
    enabled: true,
    nullRows: own.nullRows ?? 'tenantless',
    filter: () => tenantFilter(kinds ? { kinds } : undefined),
  };
}

/** The slice of nestjs-context's runtime `Context` that restores a tenant. */
export interface TenantRuntime {
  withTenant<T>(input: { id: string; kind: string; source?: string } | null, fn: () => T): T;
}

export function isTenantRuntime(x: unknown): x is TenantRuntime {
  return !!x && typeof (x as TenantRuntime).withTenant === 'function';
}

/** Restore `tenant` (read from a run row or a task carrier) as the context tenant around `fn`. */
function restore<T>(runtime: TenantRuntime, tenant: RunTenant, fn: () => T): T {
  return runtime.withTenant(
    { id: tenant.id, kind: tenant.kind ?? 'unknown', source: 'carrier' },
    fn,
  );
}

/**
 * The engine's tenancy seam (core `EngineTenancy`), or undefined when durable's tenancy is `false`
 * or the installed context cannot restore a tenant. Every member reads the context at call time.
 */
export function buildEngineTenancy(
  option: DurableTenancyOption | undefined,
  accessor: ContextAccessor | undefined,
  runtime: TenantRuntime | undefined,
): EngineTenancy | undefined {
  if (option === false || !runtime) return undefined;
  return {
    current(): RunTenant | undefined {
      const t = readTenancy(option, accessor);
      if (!t.enabled) return undefined;
      const f = t.filter();
      return f.mode === 'tenant' ? { id: f.tenant.id, kind: f.tenant.kind } : undefined;
    },
    filter(): TenantFilter {
      const t = readTenancy(option, accessor);
      if (!t.enabled) return { mode: 'system' };
      const f = t.filter();
      if (f.mode === 'tenant')
        return { mode: 'tenant', tenantId: f.tenant.id, nullRows: t.nullRows };
      if (f.mode === 'tenantless') return { mode: 'tenantless' };
      return f.mode === 'all' ? { mode: 'all' } : { mode: 'system' };
    },
    run: (tenant, fn) => restore(runtime, tenant, fn),
  };
}

/** The tenant a task carrier holds (`tenant`, else a plain `tenantId`), or undefined. */
export function tenantFromCarrier(
  carrier: Record<string, unknown> | undefined,
): RunTenant | undefined {
  const ref = carrier?.tenant as { id?: unknown; kind?: unknown } | undefined;
  if (ref && typeof ref.id === 'string') {
    return typeof ref.kind === 'string' ? { id: ref.id, kind: ref.kind } : { id: ref.id };
  }
  const id = carrier?.tenantId;
  return typeof id === 'string' ? { id } : undefined;
}

/**
 * A durable execution wrapper that runs each dispatched step handler in the tenant its task
 * carries, whatever transport delivered it and whichever process runs it.
 */
export function stepTenantWrapper(
  option: DurableTenancyOption | undefined,
  accessor: ContextAccessor | undefined,
  runtime: TenantRuntime,
): (
  execution: { unit: 'workflow' | 'step'; context?: Record<string, unknown> | undefined },
  next: () => Promise<unknown>,
) => Promise<unknown> {
  return (execution, next) => {
    if (execution.unit !== 'step') return next();
    const tenant = tenantFromCarrier(execution.context);
    if (!tenant || !readTenancy(option, accessor).enabled) return next();
    return restore(runtime, tenant, next);
  };
}
