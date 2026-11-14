---
'@dudousxd/nestjs-durable-dashboard': minor
---

Every HTTP list endpoint of the console API now speaks Aviary's list wire (`filter[field]=v` / `filter[field][op]=v`, `page` + `size`, `{ data, meta }`). The old spellings are removed, not aliased.

- `GET runs`: filters are `filter[status]`, `filter[workflow]`, `filter[namespace]`, `filter[tag]`, `filter[origin]` (one value, `a,b` or `[]` for a set, or `[eq]`/`[in]`), `filter[unattributed]=true`, and `filter[attr.<key>][eq|ne|gt|gte|lt|lte|in]`. Paging is `page` (default 1) and `size` (default 100, at most 500); the answer is `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }`, with `total` from the facet aggregate. `sort` accepts only `-createdAt`. An unknown field, an unsupported operator or a bad `page`/`size` is a 400. The flat `?status=`/`?tag=`/`?attr=key:op:value`/`?unattributed=`, `limit`/`offset` and the structured `filter[where][...]` form are gone. Filtering still runs through `@dudousxd/nestjs-filter`'s `RunFilter`.
- `GET runs/facets` takes the same filters and answers `{ data: RunFacetRow[] }`.
- `GET runs/values` keeps `groupByCount[...]`; its scope filters use the `filter[...]` wire above.
- `GET runs/:id/fans/:group` takes `page`/`size` (default 100, at most 500) and `filter[failed]=true`, and answers `{ data, meta }` (was `{ items, total }`). The ETag is unchanged.
- `GET schedules` takes `filter[namespace|workflow|tag|paused]` and `size` (default 200, at most 1000), and answers `{ data }`. It is not paged: the store cannot count schedules and their soonest-due order moves on every fire.
- `POST bulk/:action` takes the same `filter[...]` params as `GET runs`.
- Every one of these answers 400 for a query param it does not read (`limit`, `offset`, `cursor`, a bare `?status=`, `where[...]`, paging on `facets` / `bulk`, …), naming the replacement where there is one, instead of ignoring it.
- The client sends an attribute `in` set as repeated `filter[attr.<key>][in][]=` params, so a value holding a comma stays one value.

The `./client` follows: `durableClient.runs()` takes `{ page, size }` and returns `OffsetPage<WorkflowRun>`, `fanMembers()` takes `{ page, size, failed }` and returns `{ data, meta }`, and `facets()` / `schedules()` unwrap `{ data }`. `RunFilter` no longer has `@FilterFor` methods and the API controller no longer binds `ApplyFilterInterceptor`. The Runs page loads more by `page`.
