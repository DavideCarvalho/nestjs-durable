---
"@dudousxd/nestjs-durable-core": minor
---

Add `remoteByConvention` engine option: when enabled, an unregistered workflow is
automatically routed to the live worker group of the same name — no `engine.remote()`
registration boilerplate needed. The worker announcing its group IS the registration.
Default `false`; existing behavior is unchanged. Requires a transport that implements
`listWorkerGroups` (e.g. BullMQ).
