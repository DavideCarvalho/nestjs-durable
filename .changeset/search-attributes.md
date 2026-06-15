---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-store-typeorm": minor
"@dudousxd/nestjs-durable-store-prisma": minor
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable-store-drizzle": minor
"@dudousxd/nestjs-durable-dashboard": minor
---

Typed search attributes — query runs by structured data, not just exact-match tag labels.

- **Start**: `start(wf, input, id, { searchAttributes: { amount: 200, tier: 'pro' } })` stamps typed, queryable data on a run.
- **Query**: `RunQuery.attributes` takes `{ key, op, value }` predicates ANDed together, with `eq/ne/gt/gte/lt/lte` — so range queries like `amount >= 200 AND tier = 'pro'` work. Applied in-process after the coarse workflow/status/tag filters, so it's portable across all store adapters (typeorm/prisma/mikro-orm/drizzle gain a `searchAttributes` JSON column).
- **Dashboard**: an attribute filter box (`amount:gte:200, tier:eq:pro`), attribute pills on the run detail, and bulk retry/cancel honoring the same predicates. API: `GET /runs?attr=key:op:value` (repeatable).
