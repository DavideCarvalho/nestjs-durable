/**
 * Local, structural mirror of `@dudousxd/nestjs-context`'s public accessor
 * (`packages/core/src/accessor.ts`).
 *
 * We deliberately do NOT import nestjs-context (it is an OPTIONAL peer). Instead
 * we declare the same shape here and inject it via the shared
 * {@link CONTEXT_ACCESSOR} token with `@Optional()`. Any object that structurally
 * satisfies this interface — including nestjs-context's real accessor — works.
 *
 * Kept byte-aligned with nestjs-context's `ContextAccessor` (and the identical
 * mirror in `@dudousxd/nestjs-authz`): `traceId()` / `tenantId()` are REQUIRED
 * (the real accessor always provides them) and `get()` is included, so the
 * structural match stays exact when DurableModule auto-feeds the carrier.
 */
export interface UserRef {
  type: string;
  id: string | number;
}

/** Opaque shape of the context store. durable never reads it; mirrors the upstream surface. */
export type ContextStore = Record<string, unknown>;

export interface ContextAccessor {
  /** Trace id for the current request, or `undefined` when unavailable. */
  traceId(): string | undefined;
  /** Current tenant id, or `undefined` when no multi-tenant context is populated. */
  tenantId(): string | undefined;
  /** Reference to the current user, or `undefined` when unauthenticated. */
  userRef(): UserRef | undefined;
  /** The raw context store for the current request, or `undefined`. */
  get(): ContextStore | undefined;
}
