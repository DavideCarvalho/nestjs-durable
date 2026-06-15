---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
---

Carry remote workflows over the transport: `Transport.dispatchWorkflowTask` / `onDecision` (optional),
implemented by `BullMQTransport` (dispatch a WorkflowTask on `<prefix>-tasks-<group>`, consume decisions
on `<prefix>-decisions` — the queues the Python `durable-worker`'s `run_redis_workflow_worker` serves).
New `RemoteWorkflowExecutor` implements `WorkflowExecutor` over a transport (correlates each turn's
decision by `taskId`), so `engine.registerRemote(name, version, { group, executor })` drives a workflow
authored in another SDK over Redis/BullMQ. Verified end-to-end live: a Python `WorkflowWorker` replays
and the TS engine drives it across real Redis.
