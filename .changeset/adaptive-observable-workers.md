---
"@dudousxd/nestjs-durable-transport-bullmq": minor
"@dudousxd/nestjs-durable-telescope": minor
"@dudousxd/nestjs-durable-dashboard": minor
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable": minor
---

Observable + adaptive workers. Workers can now self-tune their concurrency and publish a live status
snapshot on their heartbeat, surfaced per worker in Telescope and the embedded dashboard.

- **Adaptive concurrency.** The `concurrency` option on every worker surface
  (`BullMQTransport`, `runRedisWorker`, the NestJS in-app worker, the multi-group worker module, and
  the Python `Worker`) now also accepts `'adaptive'` or `{ mode: 'adaptive', min, max, start,
  ramCeilingPct, cpuCeilingPct, tickMs }`. A control loop tunes the BullMQ Worker concurrency by an
  AIMD latency-gradient (grows only when saturated, shrinks when latency inflates = queuing), with a
  cgroup-aware RAM ceiling as a hard brake and backpressure on error/stall. A plain number stays
  fixed (default 1) — unchanged. No new dependencies (RAM/CPU read from stdlib + cgroup files).
- **Worker status on the heartbeat.** The worker-liveness heartbeat value goes from a bare timestamp
  to `{ ts, status }` JSON carrying a `WorkerStatus` (new core type): concurrency mode + live limit,
  in-flight, RSS%, CPU%, throughput/min, p95 latency, and the adaptive controller's last limit change
  (`grow`/`shrink`/`ram_ceiling`/`backpressure`/`cpu_ceiling`). Readers accept both the new JSON and
  the old bare-timestamp form, so a mixed-version fleet reports cleanly.
- **Telescope + dashboard.** A new `durable.workerStatus` data provider and a "Workers" panel show one
  row per live worker (mode, limit, in-flight/limit saturation, queue depth, RAM%, CPU%, throughput,
  p95, last adjust). The embedded dashboard's worker chips expand to a per-worker breakdown. The
  existing group-level "Worker health" panel is unchanged.

Note: `@dudousxd/nestjs-durable-transport-bullmq` now depends on `@dudousxd/durable-worker` (it reuses
the shared adaptive controller). The Python `durable-worker` client gains the same `concurrency`
knob and status payload (released separately via git tag).

See `docs/workers-when-to-use.md`.
