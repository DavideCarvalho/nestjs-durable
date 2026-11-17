---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable-dashboard": minor
---

Schedules declared on a `DurableModule` tenant (a `connection`, no `store`) now fire. A tenant worker announces its app's `schedules` on its worker descriptor (`WorkerDescriptor.schedules`, under the partition or its tenant token), and the control plane adopts them as persisted schedules with id `app:<partition>:<key>`, namespace `<partition>` and tag `schedule:announced` (`WorkflowEngine.syncAnnouncedSchedules`, run by the timer poll every 15 s; `announcedSchedules` option, on by default). Replicas announcing the same set are a no-op; on a key two deploys disagree on, the newer worker wins; a schedule no live worker announces any more is paused after `graceMs` (10 min), never deleted, and resumed if announced again. An adopted schedule fires through the tenant start path: with no live worker of the app its run waits `blocked` (`no_live_worker`) instead of the window being lost, and later windows fold into that waiting run. The console's Schedules page labels announced schedules with their app, and pause, resume and run now work on them. `ScheduleClient.tick` and `nextFireAt` take an optional `tag` filter.
