---
'@dudousxd/nestjs-durable-core': minor
---

Add `StartRunMessage` interface and `dispatchStartRun`/`onStartRun` optional methods to the `Transport` interface (P4 — start-run over the protocol). A DB-less tenant worker publishes a `StartRunMessage` onto `<effectivePrefix>-start-run`; the control plane consumes it and turns it into a durable run.

Wire the control-plane consumer end to end: `WorkflowEngine.start` accepts `opts.namespace` and stamps `namespace: opts?.namespace ?? this.namespace` on the created run, and the engine constructor registers `transport.onStartRun` (guarded by the transport capability) to turn each incoming `StartRunMessage` into `start(workflow, input, runId, { namespace: tenant, tags })` — so a start-run for `{ tenant: 't1', ... }` creates a run stamped `namespace: 't1'`.
