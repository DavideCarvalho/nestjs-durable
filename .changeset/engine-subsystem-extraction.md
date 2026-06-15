---
"@dudousxd/nestjs-durable-core": patch
---

Internal: extract the durable-entity and event-accumulator subsystems out of the engine.

Carves the `__entity` runner (now `Entities`) and the `__evt_debounce`/`__evt_batch` accumulators (now `EventAccumulators`) into their own modules, leaving the engine methods as thin delegations. Adds a canonical `engine.getRunChildren(runId)` and uses it for both the cancel cascade and the dashboard run-tree, replacing the child-discovery logic that was copy-pasted across the two. Behavior-preserving — no public API change.
