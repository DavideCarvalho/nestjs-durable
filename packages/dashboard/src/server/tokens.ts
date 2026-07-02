/**
 * Injection token for the bound `RunGateway`, owned by `@dudousxd/nestjs-durable` (the nestjs
 * package). The dashboard package does NOT depend on `@dudousxd/nestjs-durable` — its only
 * relevant peer dep is `@dudousxd/nestjs-durable-core` — so we do NOT import the token from
 * there. Instead we share its well-known token by value, the same pattern
 * `@dudousxd/nestjs-durable`'s own `tokens.ts` uses for `CONTEXT_ACCESSOR` (a cross-lib token
 * owned by `@dudousxd/nestjs-context`).
 *
 * `Symbol.for(key)` uses the global symbol registry, so this resolves to the SAME symbol
 * instance as `packages/nestjs/src/tokens.ts`'s `RUN_GATEWAY` without any import. The key MUST
 * stay byte-identical with that export.
 */
export const RUN_GATEWAY = Symbol.for('nestjs-durable:run-gateway');
