---
"@dudousxd/nestjs-durable-core": patch
---

Stamp the engine's own built-in workflows with an origin. The `__entity` runner behind durable
entities and the `__evt_debounce` / `__evt_batch` `onEvent` accumulators now register with
`origin: '@dudousxd/nestjs-durable-core'` (exported as `CORE_ORIGIN`), so a console's ORIGIN facet
files that engine plumbing under the engine instead of leaving it unattributed next to the app's runs.
