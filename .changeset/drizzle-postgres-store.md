---
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-transport-db': patch
---

The Drizzle store now runs on **PostgreSQL**, and accepts drizzle-orm 0.45.

`@dudousxd/nestjs-durable-store-drizzle/pg` is a new entry point with a `DrizzlePgStateStore` that
takes any drizzle Postgres db (node-postgres, postgres-js, PGlite, Neon, …). The package root is
unchanged and stays the SQLite / libSQL store.

- **Schema both ways.** The six `durable_*` tables ship as `pgTable`s (`durableWorkflowRuns`, …,
  bundled as `durablePgSchema`) to re-export into your drizzle-kit schema, and as idempotent DDL
  (`DURABLE_PG_DDL`, `ensureDrizzlePgDurableSchema(db)`) that `ensureSchema()` runs on boot under an
  advisory lock when `autoSchema` is on. The two are identical — `drizzle-kit push` against an
  auto-schema database reports no changes — and a real-Postgres spec pins them together.
- **Postgres-native.** `jsonb` payloads, `timestamptz` timers, canonical column names. Leases are a
  single conditional `UPDATE … RETURNING`; `takeSignalWaiter` is one `DELETE … RETURNING`;
  `takeBufferedSignal` claims with `FOR UPDATE SKIP LOCKED`. Tag filters are jsonb containment
  (`@>`) over a GIN index, so singleton gates stay index probes.
- **Retention and tenant scoping.** Implements `pruneTerminalRuns` (batches selected with
  `SKIP LOCKED`, terminal statuses only), so the module's `retention` option works, and `withScope`,
  so `scopeReads` confines reads to a namespace.
- **Broker-less remote steps.** `drizzlePgExecutor(db)` plugs the drizzle db into `DbTransport`.
  `transport-db` now marks its `typeorm` peer optional, since it only ever needed the executor.

Passes the shared StateStore contract on node-postgres and postgres-js against real Postgres.

The drizzle-orm peer range now includes `^0.45.0`; the SQLite store is tested on 0.45.3.
