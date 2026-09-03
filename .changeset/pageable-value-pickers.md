---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

Value pickers are exact, searchable and paged — not a top-100 sample

The pickers offered the hundred most common values of an axis and stopped there. On the axis that
needs them most that is barely a filter: tag cardinality grows with the data, so the value an
operator is after is routinely outside the hundred — and it was unreachable, because the search box
filtered the page it already held.

**`runValueFacets` takes `offset` and `search`**, both applied over the whole matching set and
before the bound. A picker now pages as it scrolls and narrows as the operator types, against
everything rather than against its own fetched page.

**The MikroORM store answers every axis with a real grouped query.** `tag` used to dedupe a bounded
scan of recent runs in memory — a sample, with counts describing that window and an order that could
not be paged. It now expands the JSON array in the database (`json_each` on SQLite, `JSON_TABLE` on
MySQL, `jsonb_array_elements_text` on Postgres) and groups it; the attribute axes join their side
table. Counts are exact over the whole matching set, and `scan` no longer applies to this adapter at
all. Verified against real MySQL and Postgres, not only SQLite.

Which axes need the in-memory fallback is now a property of the ADAPTER rather than of the axis — an
adapter that can express the expansion answers exactly; the others keep the documented bounded scan.

**In the console**, every filter is one control (`ValuePicker`): server-side search, debounced,
paging as it scrolls, and virtualized once enough pages have accumulated to matter. Free text still
works — the offered list is bounded by construction, so a value it does not carry has to remain
typable.
