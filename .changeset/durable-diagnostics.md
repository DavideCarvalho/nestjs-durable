---
"@dudousxd/nestjs-durable-diagnostics": minor
---

Add `@dudousxd/nestjs-durable-diagnostics`: bridge WorkflowEngine lifecycle events onto the Aviary diagnostics bus (`aviary:durable:<type>`). Ships `attachDurableDiagnostics(engine)`, a global `DurableDiagnosticsModule`, and a typed `ChannelRegistry` augmentation so `@OnDiagnostic('durable', ...)` infers an `EngineEvent` payload.
