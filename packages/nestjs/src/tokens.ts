import { RunGateway } from '@dudousxd/nestjs-durable-core';

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
 * @deprecated Inject the `RunGateway` abstract class directly (it is its own DI token now):
 * `constructor(private readonly gateway: RunGateway)`, provider `{ provide: RunGateway, useClass }`.
 * This symbol is kept as a back-compat alias — it points at the `RunGateway` class, so existing
 * `@Inject(RUN_GATEWAY)` sites resolve the very same token — and will be removed in a future major.
 *
 * `RunGateway` is owned by `@dudousxd/nestjs-durable-core` (a required peer dep of both this package
 * and the dashboard), so the abstract class is a single shared token across packages without the
 * previous `Symbol.for` value-sharing hack.
 */
export const RUN_GATEWAY = RunGateway;
