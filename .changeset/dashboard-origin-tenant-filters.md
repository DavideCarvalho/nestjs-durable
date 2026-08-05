---
'@dudousxd/nestjs-durable-dashboard': minor
---

Say which tenant and which library produced a run — and filter by both.

`/durable` now shows a run's `namespace` and `origin`, and lets an operator narrow by each. The two
halves are wired differently, on purpose.

**Tenant** was pure plumbing: `WorkflowRun.namespace` has always held it and `RunQuery.namespace` has
always filtered on it, but the dashboard never sent one. `GET runs` and `POST bulk/:action` now take a
`namespace` param, `durableClient.runs`/`bulk` send it, and the sidebar has a tenant box (the tenant
chip on a run row is a click-shortcut for it, like the tag chips). The default is unchanged and
deliberately so: no param means EVERY tenant, because read paths are not namespace-scoped and quietly
scoping them would have hidden other tenants' runs from every existing operator. A blank param is
treated as absent, so a cleared box does not become an exact match on a tenant nobody has.

**Origin** needed more than plumbing, because `RunQuery.origin` is an exact-match string and a run
with no origin matches no value at all. So the origin facet is applied in the browser, over the list
the console already holds: `all` (the default), one chip per package, and `unknown` — with counts, and
with the unknown count staying on screen while a package is selected. A store-side facet would have
reported zero unattributed runs the moment an operator picked a library, which reads as "those runs do
not exist". An origin filter that comes back empty says which of the two things happened, and offers a
jump into the unclassified runs. The run detail header states `origin unknown` outright rather than
omitting it; the server-side `origin` param is wired too, so a bulk action stays scoped to the list it
was launched from (and the bulk buttons refuse, visibly, under the `unknown` facet — the one filter
the server cannot be told about).

`@dudousxd/nestjs-durable-dashboard/client` also exports the origin helpers (`originLabel`,
`originFacets`, `filterByOrigin`, `emptyRunsNotice`, …) so an embedded run view spells an
unattributed run the same way the console does: `unknown`, never "app" and never blank.
