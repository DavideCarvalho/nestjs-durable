---
"@dudousxd/nestjs-durable-dashboard": minor
---

`@dudousxd/nestjs-filter` is now a peer dependency (`>=1.33.0 <2.0.0`) instead of a pinned dependency, so hosts must install it themselves (`pnpm add @dudousxd/nestjs-filter`), including hosts that do not use the filter library. Filter state lives in that package's module-level AsyncLocalStorage, so when the host app ran a different nestjs-filter version, pnpm installed two copies and every `filter[...]` key on the runs API returned a 500: the runner wrapped the `FilterStateUnavailableException` thrown by `RunFilter` in a `FilterMethodException`. The dashboard now uses the host's copy.
