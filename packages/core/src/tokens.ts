/**
 * Dependency-injection tokens. Adapters bind their implementations to these so `core` and
 * `@dudousxd/nestjs-durable` depend only on the interfaces in `./interfaces`.
 *
 * These use `Symbol.for(key)` (the global symbol registry), NOT `Symbol(key)`, so the token is the
 * SAME instance no matter how many times `core` is evaluated in a process. A consumer can hold more
 * than one physical copy of `core` at runtime — pnpm peer-dependency multiplexing installs a
 * separate virtual copy per distinct peer set, and the dual ESM/CJS build can be loaded once as
 * `import` (`index.js`) and once as `require` (`index.cjs`). A plain `Symbol()` would mint a
 * DISTINCT token per copy, so `DurableModule` (provider) and `DashboardService` / a store adapter
 * (injector) could resolve different symbols → Nest can't satisfy the dependency
 * (`STATE_STORE is not available in the DurableApiModule context`). A registered symbol collapses
 * them to one. Mirrors the `CONTEXT_ACCESSOR` token in `@dudousxd/nestjs-durable`'s `tokens.ts`.
 */

/**
 * @deprecated Use {@link STATE_STORE_CANONICAL} (`@dudousxd/nestjs-durable:state-store`). The legacy
 * token stays bound as a back-compat alias and still resolves; it will be removed in a future major.
 */
export const STATE_STORE = Symbol.for('nestjs-durable:STATE_STORE');
/**
 * @deprecated Use {@link TRANSPORT_CANONICAL} (`@dudousxd/nestjs-durable:transport`). The legacy
 * token stays bound as a back-compat alias and still resolves; it will be removed in a future major.
 */
export const TRANSPORT = Symbol.for('nestjs-durable:TRANSPORT');
/**
 * @deprecated Use {@link DURABLE_OPTIONS_CANONICAL} (`@dudousxd/nestjs-durable:options`). The legacy
 * token stays bound as a back-compat alias and still resolves; it will be removed in a future major.
 */
export const DURABLE_OPTIONS = Symbol.for('nestjs-durable:DURABLE_OPTIONS');

/**
 * Canonical, cross-lib-discoverable aliases of the durable DI tokens, following the ecosystem
 * capability naming `@dudousxd/nestjs-durable:<name>` (identical to `capability('durable', <name>)`).
 * `DurableModule` binds these alongside the legacy tokens (dual-bind), so an external library can
 * resolve durable's store/transport/options by the canonical name without importing durable
 * internals. Bare `Symbol.for` (same cross-copy-stability rationale as the legacy tokens above)
 * keeps `core` free of any `@dudousxd/nestjs-diagnostics` runtime dependency.
 */
export const STATE_STORE_CANONICAL = Symbol.for('@dudousxd/nestjs-durable:state-store');
export const TRANSPORT_CANONICAL = Symbol.for('@dudousxd/nestjs-durable:transport');
export const DURABLE_OPTIONS_CANONICAL = Symbol.for('@dudousxd/nestjs-durable:options');
