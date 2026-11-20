---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable-transport-bullmq": minor
---

A dispatched workflow turn that keeps killing its worker now ends `dead`, and a worker role's BullMQ lock and stall settings are configurable.

- **Lost dispatched turns spend the recovery budget.** `maxRecoveryAttempts` used to count only runs left `running` by a crashed process. A turn dispatched to a worker waits `suspended`, so one that killed its worker every time was re-dispatched by the timer poller (and redelivered by the broker) for ever. Now the due-timer pass counts a dispatched turn as lost when its re-drive deadline (`remoteAdvanceSilenceMs`, else `reconcileMs`) has passed with no decision and no heartbeat, and only then:
  - once per turn: the count marks the awaited turn (`awaitingDecisionTaskId` gains a `:lost` suffix), so a re-drive waiting on the run queue for several leases is not counted again, and the next dispatch replaces the marker;
  - only when a worker took the task: the new optional `WorkflowExecutor.taskState` / `Transport.workflowTaskState` report `queued`, `taken` or `unknown`, and a task still waiting unstarted is neither counted nor dispatched again (its deadline moves out one window). `BullMQTransport` implements it; a workflow task's job id is now `wf-<taskId>` with `:` swapped for `_`. A transport without it counts every lapse; one whose read fails counts nothing that pass;
  - only by an instance that resolves the workflow, so one that cannot counts nothing and its `workflow_not_registered` grace still runs;
  - not within one turn window of the engine's boot: a deadline that went stale while it was down is pushed out instead, so live workers' beats reach it first.

  An applied decision resets `recoveryAttempts` to 0, so only turns lost in a row add up. Past the limit the run is written `dead` with code `max_recovery_attempts` and announced like an inline run (`onDead`, `run.failed`, `@OnWorkflowFailed`, a waiting parent). Both `countRecovery` writes are now conditional on the run's status (`updateRunIf`), for inline recovery too, so a concurrent cancel is never overwritten. A run that suspends after a re-drive that ran here (an onError handoff) drops a stale awaited-turn marker. A decision that lands while the pass holds the lease and dead-letters the run is dropped with it. Without `maxRecoveryAttempts` (the default) nothing is ever dead-lettered, as before.
- **Lock and stall settings.** `runRedisWorker` takes `stalledInterval` and `maxStalledCount` beside `lockDuration`, and `DurableModule.forRoot` takes all three for the co-located and thin worker consumers and passes them to every BullMQ `Worker`. `lockDuration` still defaults to 5 minutes; `stalledInterval` and `maxStalledCount` are sent only when set, so BullMQ's defaults (30 s, 1) apply otherwise. A shorter `lockDuration` lets BullMQ redeliver a crashed worker's task sooner; keep it well above the longest event-loop stall a healthy turn can cause. With an older `@dudousxd/durable-worker`, the module's new options are ignored.
