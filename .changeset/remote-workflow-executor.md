---
'@dudousxd/nestjs-durable-core': minor
---

Drive remote (cross-SDK) workflows: `engine.registerRemote(name, version, { group, executor })`. The
engine advances such a run by handing its history to the `WorkflowExecutor` (which dispatches a
`WorkflowTask` to a worker — e.g. the Python `durable-worker`) and applying the returned
`WorkflowDecision`: it persists recorded local steps, dispatches `call` commands as remote steps, and
schedules `sleep` timers, then settles or suspends the run. Everything around it — lease, recovery,
timers, the resume on a step result — is the same machinery as an in-process workflow, so the worker
never touches the store. `waitSignal`/`startChild` commands are a follow-up (they fail loudly for now).
