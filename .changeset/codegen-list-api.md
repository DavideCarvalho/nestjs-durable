---
'@dudousxd/nestjs-durable-codegen': minor
---

`listRuns` follows the console's list wire: its query is `filter[status]`, `filter[workflow]`, `filter[namespace]`, `filter[tag]`, `filter[origin]`, `filter[unattributed]`, `page`, `size` and `sort`, and its response is `{ data: Run[]; meta: { total, perPage, currentPage, lastPage, firstPage } }` instead of `Run[]`.
