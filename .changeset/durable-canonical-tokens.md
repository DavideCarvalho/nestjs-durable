---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

Add canonical, cross-lib-discoverable aliases for the durable DI tokens — `STATE_STORE_CANONICAL`, `TRANSPORT_CANONICAL`, `DURABLE_OPTIONS_CANONICAL` (`@dudousxd/nestjs-durable:state-store` / `:transport` / `:options`, identical to `capability('durable', …)`). `DurableModule` dual-binds them as `useExisting` aliases of the existing tokens, so an external library can resolve durable's store/transport/options by the canonical capability name without importing durable internals. Fully additive and non-breaking: the legacy `nestjs-durable:*` tokens are unchanged and keep working.
