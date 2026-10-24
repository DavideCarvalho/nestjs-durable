---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable": patch
"@dudousxd/nestjs-durable-testing": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
---

Child completions no longer pile up in `durable_buffered_signals`. A run that finished with no parent waiter buffered its completion on `child:<runId>` unconditionally, unless its parent held a byte-identical `signal:child:` checkpoint. So every root run (a controller start, a schedule) left a row behind, and so did a child of a settled `ctx.all` fan of 100+ children (folded into one `fan:` checkpoint) or one whose parent's copy came back from a MySQL `json`/Postgres `jsonb` column with its keys reordered. Nothing ever read those rows.

The engine now buffers a child's completion only when its parent can still consume it: the parent exists, is not completed or cancelled, and does not already hold the outcome (compared ignoring key order, and counting a folded fan). A new `engine.sweepBufferedSignals()`, called by the NestJS timer poller, deletes the `child:` rows that fail that test, including ones earlier versions left: a few pages of 500 per tick until a pass ends, then every ten minutes; skipped on a namespaced engine. Stores gain `listBufferedSignals` (paged by id, by token prefix) and `deleteBufferedSignals`, covered by the StateStore contract. No schema change.

A parent that joins a child which already finished settles it at once: `ctx.child` (a caller-chosen id, or a spawn joined later) in the same turn from the child's run row, a fan's children with a placeholder from an earlier turn likewise (with `failFast` honoured), and any child whose deferred start (in-process or a remote `startChild` command) finds it already finished gets its completion re-delivered to the waiter it now has. Before, such a parent waited for the reconcile wake, or forever with reconcile off.
