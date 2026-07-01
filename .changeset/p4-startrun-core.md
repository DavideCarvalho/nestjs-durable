---
'@dudousxd/nestjs-durable-core': minor
---

Add `StartRunMessage` interface and `dispatchStartRun`/`onStartRun` optional methods to the `Transport` interface (P4 — start-run over the protocol). A DB-less tenant worker publishes a `StartRunMessage` onto `<effectivePrefix>-start-run`; the control plane consumes it and turns it into a durable run.
