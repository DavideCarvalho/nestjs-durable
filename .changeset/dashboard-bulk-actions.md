---
"@dudousxd/nestjs-durable-dashboard": minor
---

feat(dashboard): bulk retry/cancel by filter

Act on many runs at once: when a status or tag filter is active, the run list shows **retry all** /
**cancel all** buttons that apply to every matching run (e.g. "retry every `dead` run tagged
`type:mel`"). Backed by a new `POST bulk/:action?status=&tag=&workflow=` endpoint + `DashboardService.bulk()`
(capped at 500, terminal runs skipped, returns matched/applied counts).
