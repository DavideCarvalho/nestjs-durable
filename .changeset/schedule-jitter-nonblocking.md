---
'@dudousxd/nestjs-durable-core': patch
---

Schedule `jitter` no longer blocks the timer poll. `runSchedules` used to `sleep` each due schedule's jitter inside the tick, one schedule after another, so every other schedule and the rest of the poll (due timers, retries, timeouts) waited behind it. After a restart, with several jittered windows due at once, schedules fired many minutes late. Each window now gets its own fire time, up to `jitter` after the instance first sees it due, and a later tick starts it once that time has arrived. A window deferred past its interval still fires. Run ids and exactly-once are unchanged. The `sleep` option of `runSchedules` is deprecated and no longer called. Same fix as Agora (adonis-agora-durable#389).
