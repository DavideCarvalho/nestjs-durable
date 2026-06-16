---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-transport-bullmq": minor
---

Live per-step observability for remote (polyglot) workflows. A Python `@workflow` runs its `ctx.step`s inline over a single turn that can last minutes, so previously the engine learned of the steps only when the turn ended — the dashboard showed "no steps yet" the whole run, and when they finally landed they had a 0ms duration and no sub-process trail.

The worker now streams each local step's lifecycle as it happens, over a dedicated point-to-point `<prefix>-step-events` queue (a single engine instance consumes each event and checkpoints it once — no cross-pod duplicate writes):

- **core**: `WorkflowStepEvent` + `Transport.dispatchStepEvent`/`onStepEvent`; the engine persists a `running` checkpoint when a step's body begins and resolves it to `completed`/`failed` with the step's real wall-clock window and its sub-process/log `events`. The turn's final `recordStep` command now also carries `startedAt`/`finishedAt`/`events` and `applyCommands` honors them, so the idempotent turn-end persist matches the live one (real duration, not 0ms).
- **transport-bullmq**: implements `dispatchStepEvent`/`onStepEvent` over the `<prefix>-step-events` queue.

Result: each handler step appears `running` the moment it starts, then `completed`/`failed` with a true duration and its p-processes shown under it — live, not all at once at the end.
