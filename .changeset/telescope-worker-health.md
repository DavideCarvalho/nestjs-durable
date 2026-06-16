---
"@dudousxd/nestjs-durable-telescope": minor
---

Surface worker-health on the Telescope "Workflows" dashboard. A new `durable.workerHealth` data provider reads `WorkflowEngine.workerHealth()` (queue depth vs. live worker heartbeats), powering two new panels: a **"Starved groups"** stat (groups with work queued and zero live workers — the "alive but not consuming" alert state) and a **"Worker groups"** table (group · queued · live workers · status, starved first). Complements the `/durable` Workers panel for ops who live in Telescope.
