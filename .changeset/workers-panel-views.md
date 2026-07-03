---
"@dudousxd/nestjs-durable-dashboard": minor
---

Rework the `/durable` Workers panel into three toggleable views. After route-by-handler,
every `@Step`/`@Workflow` became its own queue, so the old panel showed one chip per handler
and buried the fact that a single worker pod serves dozens of them. The panel now defaults to a
**by-pod** view (one chip per live worker instance, with its partition, handler count, in-flight
saturation, and adaptive-concurrency status) and offers **by-partition** and **health-first
(starvation alerts)** views via a toggle. The alerts toggle surfaces a red count badge whenever a
served queue has depth but no live workers.
