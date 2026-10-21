---
'@dudousxd/nestjs-durable-core': patch
'@dudousxd/nestjs-durable-transport-bullmq': patch
---

`timerBatchSize` and `resultConcurrency` fall back to their defaults (500, 1) for a non-finite or sub-1 value. Before, `NaN` passed straight through `Math.max`, and a `NaN` timer batch stalled timer recovery on every tick.
