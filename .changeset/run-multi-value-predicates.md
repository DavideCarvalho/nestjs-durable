---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable': minor
---

Multi-value run predicates, and the distinct values behind them

`RunQuery` could only ever ask for ONE tag, ONE tenant, ONE origin. An operator comparing two
tenants, or looking at two kinds of run, had to issue two queries and read two lists.

```ts
store.listRuns({ tags: ['etl', 'nightly'], namespaces: ['acme', 'globex'] })
store.listRuns({ origins: ['@acme/billing', null] })      // …plus the runs nothing claims
store.listRuns({ attributes: [{ key: 'tier', op: 'in', values: ['pro', 'enterprise'] }] })
```

`workflows`, `statuses`, `tags`, `namespaces` and `origins` each OR within themselves and AND with
everything else; an empty set matches nothing, mirroring the `statuses` field that already worked
this way. `origins` carries `null` as a member, which is the one thing the single `origin` cannot
express: "this package plus the runs nothing could attribute".

`AttributeFilter` gains an `in` op, carrying a `values` SET. It needs to be its own operator because
two `eq` predicates on the same key are ANDed like every other pair, and no run has one attribute
with two values — so without it, a multi-select over attribute values always returns nothing.

**`StateStore.runValueFacets`** (optional, like `runFacets`) answers the other half: the distinct
values of one filter axis over the runs matching a query, with counts. It is what lets a console
offer a picker instead of a text box — every offered value returns runs, and the counts say how
many. The run-table axes are an exact `GROUP BY`; `tag` and the search-attribute axes live outside
the row (a JSON array, a side table) and are counted over a bounded scan of recent matching runs,
which `RunValueFacetOptions.scan` documents and bounds.

`RunGateway` gains the same method, so it works on a tenant deployment (no store, proxying over the
transport) as well as on the control plane.
