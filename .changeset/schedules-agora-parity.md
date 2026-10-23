---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

`runSchedules` catches up with `@adonis-agora/durable`:

- **Fix: `jitter` no longer stalls the timer poll.** A schedule with `jitter` slept up to that long on every tick, even when its window had already fired, holding up due timers, retries and timeouts behind it. It now sleeps once per window, only when the window has no run yet.
- Each engine remembers the windows whose run it has seen exist, so a window that already fired costs no store read on later ticks. Idempotency is unchanged: a window this process has not seen still goes to the store.
- `runSchedules` returns only the run ids it started. It used to return the current window's id on every call for the rest of the window.
- `ScheduledWorkflow.namespace` stamps the runs with a namespace instead of the firing instance's own, for a workflow only one pool can run.
- `runSchedules` stops firing once the engine is draining. `WorkflowEngine.isDraining()` is public.
