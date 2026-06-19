---
"@dudousxd/nestjs-durable-store-mikro-orm": patch
---

Make `ensureMikroOrmDurableSchema` resilient to legacy type-alignment failures.

A column type alignment (e.g. a legacy `longtext` column → `json`) can fail when an existing value can't cast to the target type — classically a checkpoint `events` blob truncated under an older `text` column (invalid JSON). Previously this crashed boot on every restart. Now a failed non-structural statement (a `modify`/type change) is logged and skipped — the column already holds the data and the store reads/writes it via serialization, so it stays functional — while a failed required statement (`create table` / `add column` / `add index`) still throws. Repair the underlying data out of band to converge the type.
