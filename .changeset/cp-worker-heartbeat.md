---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-transport-bullmq": minor
---

fix: a control plane that runs its own workflows shows up as a live worker

An engine consuming the run queue executes in-process `@Workflow` bodies, but it takes no task queue, so it never wrote a worker heartbeat. A control plane completing its own runs (a relay workflow every few seconds, say) showed "0 live workers / No worker heartbeat in the last window" on the dashboard's Workers page, while tenant workers on the same Redis showed up fine.

- **transport-bullmq**: `onDispatchedRun` now stamps a TTL'd liveness key, `<prefix>-runs[-<namespace>]-consumer:<instanceId>` (`EX 35`, refreshed every 10 s, removed when the consumer stops, not written while consumers are deferred), and the new `liveRunConsumers(opts?)` reads them. It is deliberately not a `-worker-heartbeat:` key: those mark a task queue someone consumes, and convention routing would send workflow tasks to a queue nothing reads.
- **core**: new optional `Transport.liveRunConsumers`. `WorkflowEngine.workerHealth()` reports each in-process workflow (registered with a body, not `__`-internal) under `tenantGroup(name, namespace)` with the live run-queue consumers as its workers, and only while one is live, so a starved queue still reads as starved. Group-served (remote) workflows are unchanged.
