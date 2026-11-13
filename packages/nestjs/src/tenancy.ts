import { AsyncLocalStorage } from 'node:async_hooks';
import type { EngineTenancy, RunTenant, TenantFilter } from '@dudousxd/nestjs-durable-core';
import type { ContextAccessor } from './context-accessor';
import {
  type Tenancy,
  type TenancyOption,
  type TenantLevel,
  readTenancy as readContextTenancy,
  tenantLabels as readTenantLabels,
} from './tenancy-reader';

/**
 * Tenancy for durable: the CUSTOMER a run belongs to (`@dudousxd/nestjs-context`'s tenant), not the
 * worker-pool `namespace`. Read through the local copy of the context's tenancy reader
 * (`./tenancy-reader`): durable never imports nestjs-context, so it works with any context version
 * or none at all. With the accessor (or its tenancy methods) missing, tenancy reads as off and
 * durable behaves exactly as without it.
 */

/**
 * The `tenancy` option of `DurableModule`. Same shape in every Aviary lib:
 * - `enabled`: `'inherit'` (default) follows `ContextModule`'s `tenancy.enabled`;
 * - `kinds`: the tenant kinds durable stamps and filters by. On a nested tenant (clinic → unit) the
 *   most specific level of the active chain whose kind is listed is the one used;
 * - `family`: read a secondary tenant family (e.g. `'account'`) instead of the primary one;
 * - `required`: with no tenant, an app-facing read or start throws the context's
 *   `TenantRequiredError` (403) instead of running tenantless. Defaults to the context's own
 *   `tenancy.required`. Durable's own work (turns, recovery, schedules, worker steps) never throws;
 * - `nullRows: 'shared'`: a tenant also sees runs with no tenant (default `'tenantless'`: it does not).
 */
export type DurableTenancyOption = TenancyOption;

/** Marks durable's own work, where no request asks for a tenant (see {@link inDurableWork}). */
const durableWork = new AsyncLocalStorage<true>();

/**
 * Run `fn` as durable's own work (a workflow turn, recovery, a worker's step): reads inside it pass
 * `required: false`, so a tenant-required app does not reject a run or a task with no tenant.
 */
export function inDurableWork<T>(fn: () => T): T {
  return durableWork.getStore() ? fn() : durableWork.run(true, fn);
}

/**
 * Read tenancy for one operation (call per operation, never once at boot). Inside durable's own work
 * (see {@link inDurableWork}) a missing tenant never throws, whatever `required` says.
 */
export function readTenancy(
  option: DurableTenancyOption | undefined,
  accessor: ContextAccessor | undefined,
): Tenancy {
  const own = option ?? 'inherit';
  const effective: TenancyOption =
    durableWork.getStore() && own !== false
      ? { ...(typeof own === 'object' ? own : {}), required: false }
      : own;
  return readContextTenancy(effective, accessor);
}

/** The slice of nestjs-context's runtime `Context` that restores a tenant (context ≥ 1.2). */
export interface TenantRuntime {
  withTenant<T>(
    input: { id: string; kind: string; source?: string } | null,
    fn: () => T,
    options?: { family?: string },
  ): T;
}

export function isTenantRuntime(x: unknown): x is TenantRuntime {
  return !!x && typeof (x as TenantRuntime).withTenant === 'function';
}

/** The read/write tenancy slot nestjs-context ≥ 2.1 publishes; read structurally, version 1. */
const TENANCY_SLOT = Symbol.for('@dudousxd/nestjs-context:tenancy');

/** The context's tenancy slot when one of a version this copy reads is published, else undefined. */
export function tenancySlot(): TenantRuntime | undefined {
  const slot = (globalThis as unknown as Record<symbol, unknown>)[TENANCY_SLOT] as
    | { version?: unknown; withTenant?: unknown }
    | undefined;
  return slot?.version === 1 && isTenantRuntime(slot) ? slot : undefined;
}

/** What restores a tenant: the context's tenancy slot when published, else the runtime `Context`. */
function restorer(runtime: TenantRuntime | undefined): TenantRuntime | undefined {
  return tenancySlot() ?? runtime;
}

/** Restore `tenant` (read from a run row or a task carrier) as the context tenant around `fn`. */
function restore<T>(
  runtime: TenantRuntime,
  option: DurableTenancyOption | undefined,
  tenant: RunTenant,
  fn: () => T,
): T {
  const family = typeof option === 'object' ? option.family : undefined;
  const ref = { id: tenant.id, kind: tenant.kind ?? 'unknown', source: 'carrier' };
  return family !== undefined
    ? runtime.withTenant(ref, fn, { family })
    : runtime.withTenant(ref, fn);
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
  if (option === false || !restorer(runtime)) return undefined;
  return {
    current(): RunTenant | undefined {
      const t = readTenancy(option, accessor);
      if (!t.enabled) return undefined;
      const f = t.filter();
      return f.mode === 'tenant' ? { id: f.tenant.id, kind: f.tenant.kind } : undefined;
    },
    filter: () => tenantFilterNow(option, accessor),
    run: (tenant, fn) => {
      const using = restorer(runtime);
      return using ? restore(using, option, tenant, fn) : fn();
    },
    system: inDurableWork,
  };
}

/** The matching filter (core `TenantFilter`) for an app-facing call made now. */
export function tenantFilterNow(
  option: DurableTenancyOption | undefined,
  accessor: ContextAccessor | undefined,
): TenantFilter {
  const t = readTenancy(option, accessor);
  if (!t.enabled) return { mode: 'system' };
  const f = t.filter();
  if (f.mode === 'tenant') return { mode: 'tenant', tenantId: f.tenant.id, nullRows: t.nullRows };
  if (f.mode === 'tenantless') return { mode: 'tenantless' };
  return f.mode === 'all' ? { mode: 'all' } : { mode: 'system' };
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
 * carries, whatever transport delivered it and whichever process runs it. The handler runs as
 * durable's own work, so a task with no tenant does not trip a tenant-required context.
 */
export function stepTenantWrapper(
  option: DurableTenancyOption | undefined,
  accessor: ContextAccessor | undefined,
  runtime: TenantRuntime | undefined,
): (
  execution: { unit: 'workflow' | 'step'; context?: Record<string, unknown> | undefined },
  next: () => Promise<unknown>,
) => Promise<unknown> {
  return (execution, next) => {
    if (execution.unit !== 'step') return next();
    return inDurableWork(() => {
      const tenant = tenantFromCarrier(execution.context);
      const using = restorer(runtime);
      if (!tenant || !using || !readTenancy(option, accessor).enabled) return next();
      return restore(using, option, tenant, next);
    });
  };
}

/** Whether durable's tenancy can restore a tenant here: the context's slot, or its runtime. */
export function canRestoreTenant(runtime: unknown): boolean {
  return tenancySlot() !== undefined || isTenantRuntime(runtime);
}

/** The tenant a `start` made now is stamped with (tenancy on), for a store-less tenant process. */
export function currentTenant(
  option: DurableTenancyOption | undefined,
  accessor: ContextAccessor | undefined,
): RunTenant | undefined {
  const t = readTenancy(option, accessor);
  if (!t.enabled) return undefined;
  const f = t.filter();
  return f.mode === 'tenant' ? { id: f.tenant.id, kind: f.tenant.kind } : undefined;
}

/** Console labels keyed by tenant id: the app's `tenancy.label`, else the slug, else the id. */
export function tenantLabels(
  tenants: TenantLevel[],
  accessor?: ContextAccessor | undefined,
): Promise<Record<string, string>> {
  return readTenantLabels(tenants, accessor);
}
