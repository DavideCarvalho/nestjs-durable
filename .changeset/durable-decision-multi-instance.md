---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-testing": patch
---

Fix: remote workflow-turn decisions are now applied durably and instance-agnostically, so a
multi-instance deployment no longer hangs runs after a `gather_calls`/remote child completes.

Previously `RemoteWorkflowExecutor` awaited each dispatched turn's decision via an in-memory,
per-instance `pending` map. With multiple engine instances sharing the broker, the `decisions` queue
is point-to-point: a decision was often consumed by an instance that did NOT dispatch the turn, which
had no matching waiter → the decision was dropped → the run stayed `suspended` forever with all its
steps `completed` (and recovery never re-drove suspended runs). Single-instance never hit it, so it
surfaced only intermittently in multi-pod deployments.

Now the engine dispatches the turn and SUSPENDS, recording `WorkflowRun.awaitingDecisionTaskId`. A new
`completeRemoteDecision` (wired on every instance) applies the decision on whichever instance receives
it — looked up by `decision.runId`, gated on the awaited `taskId` (stale/duplicate/foreign decisions
ignored), durably — mirroring how remote step results already work. `RemoteWorkflowExecutor` is now a
fire-and-forget dispatcher (no in-memory await). Liveness moved to recovery: a run awaiting a decision
past its `remoteAdvanceSilenceMs` window is re-driven by the timer poller (heartbeat-rearmed), which
also fixes stuck `suspended` runs never being recovered. The store adapters persist the new
`awaitingDecisionTaskId` column (additive, nullable; mikro-orm/typeorm autoSchema add it on boot).
