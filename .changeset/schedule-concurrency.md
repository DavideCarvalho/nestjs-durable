---
'@dudousxd/nestjs-durable-core': minor
---

A persisted schedule can carry a **concurrency quota**: `engine.schedules.create/upsert({ …, concurrency: { key, limit, countStatuses? } })` applies it to every run the schedule starts (exactly like `StartOptions.concurrency`). A window whose start would exceed the quota is skipped, recorded as the schedule's `lastError`, and the schedule moves on to its next window; `get`/`list` report the quota.
