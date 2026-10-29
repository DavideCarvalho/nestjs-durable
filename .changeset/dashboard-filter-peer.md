---
"@dudousxd/nestjs-durable-dashboard": patch
---

`@dudousxd/nestjs-filter` is now a peer dependency (`>=1.33.0 <2.0.0`) instead of a pinned dependency. Filter state lives in that package's module-level AsyncLocalStorage, so when the host app ran a different nestjs-filter version, pnpm installed two copies and every `filter[...]` key on `GET /api/durable/runs` threw `FilterStateUnavailableException` (a 500). Apps must now have `@dudousxd/nestjs-filter` installed themselves; the dashboard uses that copy.
