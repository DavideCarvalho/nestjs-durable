---
'@dudousxd/nestjs-durable-store-mikro-orm': patch
'@dudousxd/nestjs-durable-store-typeorm': patch
'@dudousxd/nestjs-durable-store-drizzle': patch
'@dudousxd/nestjs-durable-store-prisma': patch
---

Add `durableManagedTables()`, returning the fixed list of tables this store creates/manages (`durable_workflow_runs`, `durable_step_checkpoints`, `durable_run_attributes`, `durable_signal_waiters`, `durable_buffered_signals`). Feed it to your ORM's migration differ exclude/skipTables list so a schema diff never proposes dropping them, instead of hand-maintaining a regex denylist (e.g. `skipTables: [/^durable_/]`) that can drift from what the store actually owns.
