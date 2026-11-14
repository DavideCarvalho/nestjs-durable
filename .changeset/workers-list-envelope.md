---
'@dudousxd/nestjs-durable-dashboard': minor
---

`GET workers` follows the console's list wire like the other list endpoints: it answers `{ data: GroupHealth[] }` (was a bare array) and 400 for any query param, since it reads none (`?limit=1` was silently ignored; the 400 says `limit` has no replacement here). `durableClient.workers()` unwraps `{ data }`, so the Workers page, the runs board and the spans timeline are unchanged.
