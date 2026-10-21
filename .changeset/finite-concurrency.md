---
'@dudousxd/durable-worker': patch
'@dudousxd/nestjs-durable-transport-bullmq': patch
---

A `concurrency` that is not a finite number of at least 1 falls back to its default instead of reaching BullMQ, which throws on it. The adaptive config gets the same guard: a bad `min`, `max`, `start` or `tickMs` uses its default (a `NaN` `tickMs` ran the control loop every millisecond), a bad `ramCeilingPct` uses 85 (a `NaN` one never braked), and a bad `cpuCeilingPct` turns the CPU ceiling off. Fractional counts are rounded down.
