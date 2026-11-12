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
 * @deprecated Inject the `RunGateway` class, which is its own DI token:
 * `constructor(private readonly gateway: RunGateway)`. Kept because published
 * `@dudousxd/nestjs-agent` and `@dudousxd/nestjs-agent-opencode` releases import it; it is the
 * `RunGateway` class itself, so `@Inject(RUN_GATEWAY)` resolves the same provider.
 */
export const RUN_GATEWAY = RunGateway;
