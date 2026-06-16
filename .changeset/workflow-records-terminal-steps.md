---
"@dudousxd/nestjs-durable-core": patch
---

Record local steps that ran on the same turn a remote (polyglot) workflow terminates. The engine only applied a decision's `recordStep` commands on the `continue`/suspend branch — so a workflow that runs straight to completion (or failure) in a single turn, every step inline and never suspending (e.g. a Python `@workflow` whose body is a sequence of `ctx.step` calls), had all its step checkpoints silently dropped. The run showed `completed` with output but **zero recorded steps**, and a parent that awaited it via `ctx.child` then had nothing to expand inline. The `completed` and `failed` branches now apply the final turn's commands before marking the run terminal, so single-turn workflows persist their steps (including the failed one).
