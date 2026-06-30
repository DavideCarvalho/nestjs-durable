---
'@dudousxd/nestjs-durable-store-mikro-orm': minor
---

Gate `ensureMikroOrmDurableSchema` behind a schema fingerprint so steady-state boots skip the expensive work. Previously every boot of every pod ran `getUpdateSchemaSQL({ safe: true })` — which introspects the WHOLE database's `information_schema` because the store shares the app ORM — plus 5 keyed `information_schema.tables` collation probes, even when nothing had changed.

A new `durable_schema_meta` marker table records the fingerprint of the durable schema last applied. Each boot computes the expected fingerprint purely in-memory from the entity metadata (canonical, sorted serialization of each owned table's columns + indexes, plus the configured `collate` and a hand-bumpable `SCHEMA_REVISION`) and compares it to the stored one. When they match, the gate returns after two cheap round-trips (a `CREATE TABLE IF NOT EXISTS` for the marker + one PK read), skipping both the introspection and the collation probes entirely.

A fresh/empty DB (no marker) and CI still auto-create everything zero-config. The full heal re-runs only when the fingerprint is absent or stale — an entity/metadata change or a `SCHEMA_REVISION` bump — under a best-effort cross-pod advisory lock (MySQL `GET_LOCK` / Postgres `pg_advisory_lock`, skipped on SQLite) with a re-check after acquiring in case a sibling pod healed first. Caller-facing `autoSchema` behavior is unchanged.
