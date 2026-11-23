---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-testing": patch
---

`listRuns` no longer fails on MySQL when one run's payload is larger than the sort buffer.

- store-mikro-orm, store-prisma: `listRuns` sorts and pages over run ids alone, then loads those rows in chunks of 500. Ordering whole rows made MySQL carry every column, JSON included, through `sort_buffer_size` (256KB by default), so a single run with a large `input`, `output` or `error` failed every page with "Out of sort memory" (the dashboard's run list answered 500).
- core: a `GatherError` message names the first ten failed child ids and counts the rest ("... and 3319 more"). It is persisted as the run's error, and a large fan used to store every failed id in it twice (message and stack). `failures` still carries every item.
- testing: the StateStore contract lists runs around one whose error is larger than MySQL's default sort buffer.
