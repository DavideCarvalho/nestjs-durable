---
"@dudousxd/nestjs-durable-store-mikro-orm": patch
---

Persist `parallelGroup` on step checkpoints. A `ctx.gather`/`ctx.all` fan tags every sibling step with the same group so the dashboard renders them as one "ran in parallel" group, and the core engine carries it (including from a remote/polyglot worker's `recordStep`). The MikroORM store, however, had no column for it, so `toCheckpointEntity` dropped it on insert and `fromCheckpointEntity` returned `undefined` — the fan always rendered as N sequential `single` rows. Adds a nullable `parallel_group` column (auto-added on boot by `ensureMikroOrmDurableSchema`, no manual migration) and maps it in both directions.
