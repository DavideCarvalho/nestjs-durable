---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/durable-worker': minor
---

Ambient step logger — record step events from anywhere inside a handler, without threading the `StepLogger` down.

The Python SDK has had context-local step access for a while (`current_step`, `log`, `sub`, `sub_event`, `sub_process`); TypeScript only ever handed the `StepLogger` to the step body as its second argument. A generic utility a few layers below the handler (a batch inserter, an HTTP client) therefore could not emit without every signature on the path being edited — which contradicts the library's own goal that "observability is symmetric regardless of where the step ran".

**core** — new `ambient-step.ts`, mirroring `ambient-ctx.ts` (the `AsyncLocalStorage` lives on `globalThis` under a `Symbol.for` key, so duplicate copies of core in a dependency tree share one storage):

- `runInStepLogger(logger, fn)` / `currentStep(): StepLogger | undefined`
- module-level shortcuts for the logger surface: `sub(...)`, `subEvent(...)`, `subProcess(name, body, opts?)`
- log lines in both spellings: `debug` / `info` / `warn` / `error` (one per `StepLogger` method — the idiomatic TS form, for a level known at the call site) and `log(level, message, data?)` (the literal twin of the Python SDK's `log`, for a level that is computed)

The engine installs the ALS at every point a logger is born — the local-step path (`ctx.step` in `workflow-ctx.ts`) and the remote-worker path (`runStepHandler`, so every transport gets it) — binding the SAME instance the body already receives as its argument, never a second one. Concurrent step invocations each see their own logger.

**worker** — the thin worker runtime binds it too, on both its step-handler path (`StepWorker.processTask`) and its local-step path (`WorkflowContext.runStepBody`).

Outside a step everything is a no-op: `currentStep()` returns `undefined`, `log`/`sub`/`subEvent` do nothing, and `subProcess` still runs its body (and still hands it a handle) but emits nothing. That is what lets a generic utility be instrumented with no `if` at the call site and stay usable in a unit test with no durable run around it.

Purely additive: the `StepLogger` second argument is unchanged.
