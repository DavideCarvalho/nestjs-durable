---
"@dudousxd/nestjs-durable-transport-bullmq": patch
"@dudousxd/nestjs-durable-admission-redis": patch
"@dudousxd/durable-worker": patch
---

Closing while a pub/sub subscribe is still queued no longer raises an unhandled "Connection is closed." rejection. The queued `subscribe` calls (control, heartbeat, run reply, tenant event, admission freed channel, worker control channel) now handle their rejection: dropped once closing began, logged otherwise.
