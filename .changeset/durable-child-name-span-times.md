---
"@dudousxd/nestjs-durable-dashboard": patch
---

Child nodes/rows read the child's real workflow name (fetched for every visible child), not the raw `signal:child:<id>` / `spawn:<id>` checkpoint name — in both the graph and the spans waterfall. The spans waterfall now sizes each bar by the step's own `[startedAt, finishedAt]` window (a true gantt) instead of the inter-checkpoint gap, so a bar's width is the step's real duration and waits between steps read as gaps.
