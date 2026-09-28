---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable-dashboard': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
---

**Persisted schedules** — Temporal-style schedules managed at runtime and stored next to the runs,
instead of only the code-registered `schedules` option.

- `engine.schedules`: `create` / `upsert` / `get` / `list` / `pause(note?)` / `resume` / `trigger` /
  `delete` / `tick`. A schedule starts `workflow` with `input` on a `cron` (+ IANA `timezone`) or a
  fixed `every` interval, with a stable per-window `jitter`, an `overlap` policy (`allow` / `skip`
  while the previous run is in flight), a `catchup` policy (`latest` missed window once, or `skip`),
  `tags` (also stamped on its runs, plus `schedule:<id>`), `searchAttributes`, `priority` and a
  `namespace`. Failed starts are recorded as `lastError`; `get`/`list` report next/last fire, last run
  and fire count.
- **Multi-worker safe without locks**: a window's run id is deterministic (`sched:<id>:<windowMs>`, so
  racing starts collapse) and advancing a schedule is a compare-and-set on its `next_fire_at`.
- `DurableModule.forRoot({ persistedSchedules: true })` fires due schedules on every timer-poll tick
  (off by default — a deployment that never uses them doesn't need the new table).
- New `durable_schedules` table and five optional `StateStore` methods (`saveSchedule`, `getSchedule`,
  `updateSchedule` with CAS, `deleteSchedule`, `listSchedules`), implemented by every bundled store:
  in-memory, Drizzle SQLite + Postgres (pgTable + DDL), TypeORM and MikroORM (auto-schema), Prisma
  (`DurableSchedule` model to copy). `CodecStateStore` forwards them and encodes the schedule input.
  Drizzle SQLite users run `drizzle-kit generate`; Prisma users add the model — only if they use it.
- Dashboard: a header **schedules** chip listing cadence / next / last / error with pause, resume and
  run-now; API `GET /schedules`, `POST /schedules/:id/{pause,resume,trigger}`.
- Core exports `nextCronFireMs` (the forward counterpart of `prevCronFireMs`).
