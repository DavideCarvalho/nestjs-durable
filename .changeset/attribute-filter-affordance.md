---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

Three fixes to the console's value pickers, from watching one on real data

**The attribute filter did not look like a filter.** Tag and tenant render as bordered picker rows;
search attributes rendered as a small dashed `⛃ attribute` chip, which reads as an empty decoration
next to them. An operator reported the attribute filter as "empty" without ever opening it — and they
were right about the affordance, whatever was behind it. It is now the same bordered row as the other
two, showing its active predicates inline, with the builder behind it.

**Engine-minted tags drowned the tag picker.** A singleton workflow stamps `singleton:<key>` on every
run, so that family's cardinality grows with the data. Measured on a 12k-run control plane, **82 of
the top 100 tags were `singleton:*`**, pushing real tags like `type:mvr` to the edge of the list and
past it. Those tags now rank after everything else — still offered, since a run row's tag chip sets
exactly one of them, just no longer ahead of the tags a human wrote. `version:undeclared` is
engine-minted too but is a single fixed value, so it keeps competing on count.

**The MikroORM store read payloads to count strings.** The axes that cannot be grouped in the
database (`tag`, and the two attribute axes) were counted by paging `listRuns`, which fetches
`input`, `output` and `error` for every run in the scan window — tens of megabytes on a real control
plane, to produce a list of a hundred short strings, every time a picker opens. They now project only
what each question needs: the tags column, or the run ids that drive one grouped read of the
side table.

A picker also says **"couldn't load values"** now instead of rendering the same empty list a failed
request produced — the same silence that let a broken filter wire look like a console with nothing to
offer.
