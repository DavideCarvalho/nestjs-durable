---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable": patch
"@dudousxd/nestjs-durable-dashboard": patch
"@dudousxd/nestjs-durable-telescope": patch
---

Migrate all internal consumers (engine factory, registrars, timer poller, dashboard service, telescope data providers) to the canonical capability tokens, and flip the dual-bind so the canonical token (`@dudousxd/nestjs-durable:state-store`/`:transport`/`:options`) is the real provider while the legacy `nestjs-durable:*` tokens become `useExisting` back-compat aliases. The legacy tokens are now `@deprecated` but still resolve to the same instances — fully non-breaking.
