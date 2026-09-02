---
'@dudousxd/nestjs-durable-dashboard': minor
---

The console's tag, tenant and attribute filters are pickers now, and take several values

They were free-text boxes. An operator had to already know a tenant name or a tag to use one, and a
typo returned an empty list that reads exactly like "no runs match" — worst of all for search
attributes, where both the key and the value are data nobody memorises.

Each control now lists what the runs actually contain, counted server-side over the runs the OTHER
filters already select: pick a tenant, and the tag picker narrows to that tenant's tags. Every
control takes several values (ORed within the axis, ANDed across them), and clicking a tag on a run
row ADDS it to the selection instead of replacing it. Typed text still works — the offered list is a
bounded top-N, so a rare value can be real and absent, and Enter takes it as typed.

The predicates themselves are now parsed, validated and translated by
[`@dudousxd/nestjs-filter`](https://www.npmjs.com/package/@dudousxd/nestjs-filter): the console sends
its structured wire, `RunFilter` declares the surface, and a `RunQueryAdapter` translates it into a
`RunQuery` against the run gateway — so it still works on every store adapter AND on a tenant
deployment with no store at all. A field/operator pair the run store cannot answer is REJECTED by
name rather than dropped, because a dropped predicate returns a wider result set that looks like a
successful query.

Two notes for hosts:

- `GET runs/values` is new: `?groupByCount[field]=tag&groupByCount[limit]=20` plus the usual
  filters, answering `{ value, count }[]`.
- If your app already calls `FilterModule.forRoot(...)`, pass `filterModule: 'host'` to
  `DurableDashboardModule.forRoot` so this module registers only its own filter and adapter. That
  adapter is bound to its own token either way, so your global adapter keeps answering for your
  filters and the run gateway answers for the console's, in one process.

Every existing query-string spelling still works, including the repeated-param form
(`?tag=etl&tag=nightly` is the flat spelling of a set) and `?attr=tier:in:pro|enterprise`.
