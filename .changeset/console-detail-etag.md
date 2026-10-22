---
'@dudousxd/nestjs-durable-dashboard': minor
---

`GET runs/:id` and `GET runs/:id/fans/:group` send an `ETag` with `Cache-Control: private, no-cache` whenever the gateway can version the response. A poll whose `If-None-Match` still names that ETag gets a bare `304`, and the timeline is never read. The browser adds `If-None-Match` to the console's `fetch` polls by itself and hands TanStack Query the cached body, so the client needs no change. A gateway that cannot version a response (an older operator, a custom store without the aggregates, `?full=true`) answers in full as before.
