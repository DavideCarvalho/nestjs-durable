---
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable": minor
---

Per-name worker concurrency. `runRedisWorker({ concurrencyByHandler })` and `DurableModule.forRoot({ concurrencyByHandler })` give the BullMQ Worker of each named workflow or step queue its own concurrency (a number or an adaptive config), on the co-located and the thin worker alike. Every other queue keeps `concurrency` (default 1), so nothing changes unless the map is set. The key is the exact `@Workflow({ name })` / `@Step(name)` string, namespace included. Each overridden queue runs on its own controller and reports its own limit and in-flight count on the worker heartbeat. A name the process does not register is ignored, with one warning per name per process. The nestjs package's `@dudousxd/durable-worker` peer floor rises to 0.23.0, the first worker that reads the map.
