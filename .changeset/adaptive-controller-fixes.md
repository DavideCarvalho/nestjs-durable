---
'@dudousxd/durable-worker': patch
'@dudousxd/nestjs-durable-transport-bullmq': patch
---

Adaptive concurrency controller fixes:

- `throughputPerMin` on the worker heartbeat is now a rate over the trailing minute. It decays while a worker sits idle and reads 0 once a minute passes with no completion, instead of reporting the last burst's rate forever.
- In fixed mode (`concurrency` is a plain number) the controller no longer runs its control-loop timer. The limit stays the fixed value; the heartbeat snapshot samples CPU itself, at most once per 2s, so `cpuPct` is still reported.
- `AdaptiveController` takes optional `readCpuUsage` and `readCpuCount` readers (defaults `process.cpuUsage()` and `os.cpus().length`), so the CPU ceiling can be driven in tests. A non-finite core count falls back to 1.
