---
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-testing": patch
---

Fix step results never settling on MySQL when a JSON value is an array. `settleResultsIfPending` bound `events` (and any array `output` or `error`) unserialized, so the driver expanded it into a SQL value list and MySQL rejected the update; the run stayed `suspended` forever. JSON values are now serialized before they are bound, and the state-store contract settles a result with array `events` and `output`.
