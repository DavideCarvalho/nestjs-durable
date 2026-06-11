/**
 * Dependency-injection tokens. Adapters bind their implementations to these so `core` and
 * `@dudousxd/nestjs-durable` depend only on the interfaces in `./interfaces`.
 */

export const STATE_STORE = Symbol('nestjs-durable:STATE_STORE');
export const TRANSPORT = Symbol('nestjs-durable:TRANSPORT');
export const DURABLE_OPTIONS = Symbol('nestjs-durable:DURABLE_OPTIONS');
