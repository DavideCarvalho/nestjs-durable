import type { ModuleRef } from '@nestjs/core';
import type { ContextAccessor } from './context-accessor';
import type { TenantRuntime } from './tenancy';
import { CONTEXT_ACCESSOR } from './tokens';

/**
 * Locate the context accessor non-strictly: an accessor provided by ANY module (a global
 * `ContextModule` from `@dudousxd/nestjs-context`, or the app root) is found via {@link ModuleRef},
 * because DurableModule is `global` and its engine factory can't see another module's local
 * providers directly. Returns undefined when the optional peer isn't installed/bound.
 */
export function resolveAccessor(moduleRef: ModuleRef): ContextAccessor | undefined {
  try {
    return moduleRef.get<ContextAccessor>(CONTEXT_ACCESSOR, { strict: false });
  } catch {
    return undefined;
  }
}

/** True when nestjs-context publishes its accessor on the global slot (even with no DI binding). */
export function contextSlotPresent(): boolean {
  const slot = (globalThis as unknown as Record<symbol, { current?: unknown } | undefined>)[
    Symbol.for('@dudousxd/nestjs-diagnostics:accessor')
  ];
  return !!slot?.current;
}

/**
 * The slice of `@dudousxd/nestjs-context`'s module-level `Context` singleton we use to re-hydrate the
 * originating context around durable work. Structural — we never import the package's types (it
 * is an OPTIONAL peer); the guarded dynamic import below captures whatever the installed package
 * exports as `Context`.
 */
export interface ContextRuntime {
  /** Re-hydrate a context from an opaque carrier and run `fn` inside its ALS scope. */
  deserialize<T>(carrier: Record<string, unknown>, fn: () => T): T;
  /** Run `fn` with a tenant (nestjs-context ≥ 1.2). Absent on an older context: tenancy stays off. */
  withTenant?: TenantRuntime['withTenant'];
}

function isContextRuntime(x: unknown): x is ContextRuntime {
  return !!x && typeof (x as ContextRuntime).deserialize === 'function';
}

/**
 * Resolve `@dudousxd/nestjs-context`'s runtime `Context` singleton via a GUARDED dynamic import — used
 * to build the `rehydrate` bridge. The runtime `Context` (its `deserialize`/ALS `run`) is a
 * module-level singleton, NOT a DI provider behind {@link CONTEXT_ACCESSOR}, so it can't be resolved
 * through ModuleRef — we import it directly. We do NOT add a hard/static import (the peer is optional):
 * a failure (peer not installed) returns undefined and the caller falls back to passthrough.
 */
export async function resolveContextRuntime(): Promise<ContextRuntime | undefined> {
  try {
    // Indirect the specifier through a variable so the compiler does not try to STATICALLY resolve
    // the optional peer (it may be uninstalled). This stays a runtime guarded import — a missing
    // module rejects and is caught below.
    const specifier = '@dudousxd/nestjs-context';
    const mod = (await import(specifier)) as { Context?: unknown };
    return isContextRuntime(mod.Context) ? mod.Context : undefined;
  } catch {
    return undefined;
  }
}

/** Restores a context carrier around `fn`: the engine's and the worker runtime's `rehydrate`. */
export type ContextRehydrateBridge = <T>(
  carrier: Record<string, unknown> | undefined,
  fn: () => T,
) => T;

/** The `rehydrate` bridge over `runtime.deserialize`; an empty or missing carrier just runs `fn`. */
export function rehydrateBridge(runtime: ContextRuntime): ContextRehydrateBridge {
  return <T>(carrier: Record<string, unknown> | undefined, fn: () => T): T =>
    carrier && Object.keys(carrier).length > 0 ? runtime.deserialize(carrier, fn) : fn();
}

/**
 * The `rehydrate` bridge a worker runtime takes around each dispatched turn and step, the same one
 * the engine takes around a local step: nestjs-context's `Context.deserialize`, so the app's own
 * `deserialize` decides what a carrier restores. Undefined, as for the engine, unless a context
 * accessor is bound and nestjs-context's runtime loads; the worker then restores nothing.
 */
export async function resolveContextRehydrate(
  moduleRef: ModuleRef,
): Promise<ContextRehydrateBridge | undefined> {
  if (resolveAccessor(moduleRef) === undefined) return undefined;
  const runtime = await resolveContextRuntime();
  return runtime ? rehydrateBridge(runtime) : undefined;
}
