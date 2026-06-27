---
"@dudousxd/nestjs-durable-telescope": patch
---

Fix state-breakdown pie palette so each status reads with the semantically-correct color (completed=green, failed=red), aligned index-for-index with the status list.
Deduplicate triplicated run lifecycle events (the engine emits each event on every pod) by `${event}:${runId}` before aggregating, so throughput, success rate, runs-over-time, timeseries and duration are no longer inflated ~3×.
