---
'@dudousxd/nestjs-durable-testing': minor
---

Cover `origin` (and `priority`) in the cross-adapter contract instead of four times over.

`DURABLE_CANONICAL_COLUMNS` gains `origin` and `priority`. Both were already `origin`/`priority` in
all four adapters, so nothing changes for a canonical store — but until now each adapter asserted its
own physical name, which is the per-adapter duplication this map exists to remove. `origin` is the
easiest of the lot to get wrong quietly: it is a single word, so `snake_case` and `preserve` agree and
an adapter can look canonical by accident right up until it doesn't.

`namespace` stays out, and the docblock now says why: only the MikroORM adapter has that column. The
map is walked as a requirement, so listing a column three adapters don't declare would fail them for a
divergence they aren't guilty of. That absence records a real cross-adapter gap, not a naming one.

`runStateStoreContract` gains the `origin` round trip: a run stored with one reads it back, a run
stored without one reads back `undefined`, and `RunQuery.origin` matches the first and **not** the
second. That last clause is the point. `undefined` means UNKNOWN and filtering is plain equality, so
an unattributed run has to match no origin value at all — a store that widened the predicate to
`= x OR IS NULL` would make its facet look complete while quietly re-attributing runs nobody could
attribute. An external adapter running this contract now gets that case for free.
