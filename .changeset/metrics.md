---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-dashboard": minor
---

feat: Prometheus metrics

`collectMetrics(engine)` subscribes to the engine's lifecycle events and accumulates dependency-free
counters — runs + steps by outcome, per-workflow run counts, step-duration sum/count. Call
`.prometheus()` for the text exposition or `.snapshot()` for raw numbers. The dashboard wires it
automatically and serves it at `GET <apiBasePath>/metrics` for a scrape.
