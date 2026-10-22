---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/durable-worker": patch
---

`onError` routes: when a run ends `failed` with an error whose `code` matches, the engine starts a handler workflow (`<runId>.onError`, input `{ runId, workflow, input, error }`) instead of failing the run, and the run settles with the handler's outcome. The run only follows its handler from then on; its body never runs again. Engine-orchestrated, so it holds for inline, in-app-worker and remote bodies: routes come from the local registration (`@OnError(ErrorClass | code?)` methods, `@Workflow({ onError })`, `register` / `registerRemote({ onError })`) or, for a workflow served by convention, from the `onError` its live workers announce on `WorkflowRegistration` (new golden fixture `descriptor-on-error.json`; the Python SDK announces it via `@worker.workflow(..., on_error=[...])`). `NonDeterminismError` now carries `code: 'non_determinism'`, which is never routed.
