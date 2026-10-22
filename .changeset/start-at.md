---
'@dudousxd/nestjs-durable-core': minor
---

`StartOptions.startAt` (epoch ms or a `Date`) delays a run's start. The run is created `suspended` with its `wakeAt` set to that time, the same durable timer `ctx.sleep` parks on, and the timer poller starts it once due, on any instance. Nothing is held in memory and the delay survives restarts. A time that is not in the future starts the run at once. While it waits the run reads `suspended`, `start` returns `suspended`, and it counts as in flight for singleton back-pressure and concurrency quotas; it skips the `run.started` event's `pending → running` hop.
