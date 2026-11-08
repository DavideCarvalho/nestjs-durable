---
'@dudousxd/nestjs-durable-store-drizzle': minor
---

On node-postgres the hot statements are now named prepared statements by default (`preparedStatements` defaults to `true`): Postgres parses each once per connection, which halved its CPU per workflow in the bench (`localStep` 233 → 644 wf/s, dispatched `ctx.step` 78 → 197). **Breaking behind PgBouncer in transaction mode before 1.21** (no protocol-level prepared statements): pass `new DrizzlePgStateStore(db, { preparedStatements: false })` there.
