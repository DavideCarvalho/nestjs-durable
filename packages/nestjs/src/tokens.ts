/**
 * Cross-lib injection token for the current-request context accessor, owned by
 * `@dudousxd/nestjs-context`. We do NOT import nestjs-context (it is an OPTIONAL
 * peer dependency) — instead we share its well-known token by value so DI
 * resolves the same provider when nestjs-context is installed and present.
 *
 * `Symbol.for(key)` uses the global symbol registry, so this resolves to the
 * SAME symbol instance as nestjs-context's `tokens.ts` (and the identical token
 * declared by `@dudousxd/nestjs-authz`) without any import. The key MUST stay
 * byte-identical with nestjs-context's export.
 */
export const CONTEXT_ACCESSOR = Symbol.for('@dudousxd/nestjs-context:accessor');

/**
 * Injection token for the bound `RunGateway` — the read/control surface a consumer (a controller,
 * or the `RunRequestResponder`) uses instead of reaching for `WorkflowEngine`/`StateStore`
 * directly. `DurableModule` binds it to `StoreRunGateway` on worker/drive (operator) instances.
 * `Symbol.for` so re-resolving this module (e.g. across a dynamic-module boundary) still hits the
 * same registration.
 */
export const RUN_GATEWAY = Symbol.for('nestjs-durable:run-gateway');
