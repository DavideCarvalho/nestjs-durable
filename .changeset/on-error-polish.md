---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": patch
"@dudousxd/nestjs-durable-otel": minor
"@dudousxd/nestjs-durable-telescope": patch
"@dudousxd/nestjs-durable-dashboard": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-testing": patch
---

onError polish:
- Metrics count `run.routed` / `run.unrouted` (`runs.routed`, `runs.unrouted`, `routedByCode`, Prometheus `durable_runs_routed_total{code}`); the OTel bridge adds `durable.run.routed` / `durable.run.unrouted` span events; Telescope tags them `routed` / `unrouted` and `onError:<code>`, with the `reason`.
- The console shows a failure's `code` and `details` on the failed step and run.
- The boot warning for an unserved onError route rechecks after 30s, so handlers whose workers start later are not reported.
- A retry drops the run's `onError:<code>` tag along with the retired handoff.
- `listCheckpointsByNamePrefix` and `listSignalWaiters` match a prefix literally on every SQL store: `_` / `%` were read as `LIKE` wildcards (and Prisma's `startsWith` on SQLite). New conformance case.
- Python: `ctx.gather_calls_settled`.
