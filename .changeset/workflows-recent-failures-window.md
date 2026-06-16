---
'@dudousxd/nestjs-durable-telescope': minor
---

Workflows dashboard "Recent failed runs" table is now time-bounded and shows when each failure happened. The `durable.recentFailures` provider only returns failures updated within a window (default 24h; `durableTelescopeExtension({ recentFailuresWindowMs })` to tune, `0` for all) and includes a compact `updatedAt` stamp per row — so a healthy system shows an empty table instead of surfacing days-old failures as if they were a live incident.
