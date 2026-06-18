---
"@dudousxd/nestjs-durable-store-mikro-orm": minor
---

Support MikroORM v7. The adapter now targets `@mikro-orm/core` ^7 (peer dependency),
aligning it with `@dudousxd/nestjs-filter-mikro-orm` and MikroORM-v7 host apps. Store
behavior is unchanged — the shared state-store conformance contract passes on v7 against
SQLite, MySQL, and Postgres.

BREAKING: requires MikroORM v7 (`@mikro-orm/core` ^7) and `@mikro-orm/decorators` ^7 as
peer dependencies; `@mikro-orm/better-sqlite` is replaced by `@mikro-orm/sqlite` in v7.
Hosts still on MikroORM v6 should stay on the previous version of this adapter.
