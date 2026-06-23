---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable": minor
---

Track A liveness-rearm: a per-run heartbeat that lets a remote workflow `advance` self-heal a dead worker without re-driving a live (slow) one.

- **core:** new opt-in `WorkflowEngineDeps.remoteAdvanceSilenceMs`. When set, the engine wraps the remote workflow `advance` in a heartbeat-rearmed deadline keyed by `runId`: each run-scoped `Heartbeat` (a beat with no `stepId`) rearms the window, and only a genuinely-silent worker trips `RemoteWorkflowTimeout` → lease released → recovery re-drives. This closes the duplicate-side-effect hazard of a fixed `RemoteWorkflowExecutor` `timeoutMs` (which can fire mid-step on a still-working worker). Default unset = prior unbounded await — no behavior change. `Heartbeat.stepId` is now optional to carry run-scoped beats. Internally, the per-step liveness helper was generalized into a single `awaitWithLivenessDeadline` reused by both the step and workflow paths.
- **durable-worker:** the Node workflow worker now emits a run-scoped heartbeat on the shared `<prefix>-heartbeat` channel while replaying a turn (immediate + every 5s, cleared on settle), so an engine configured with `remoteAdvanceSilenceMs` keeps a slow-but-alive worker alive instead of re-driving it.
