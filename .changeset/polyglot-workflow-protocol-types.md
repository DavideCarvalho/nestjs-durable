---
'@dudousxd/nestjs-durable-core': minor
---

Add the polyglot-workflow protocol types: `WorkflowTask`, `HistoryEvent`, `WorkflowCommand`,
`WorkflowDecision`, and the `WorkflowExecutor` interface. These define the coordinator-driven contract
by which a workflow authored in another SDK (e.g. the Python `durable-worker`) is advanced by the
engine one turn at a time — the engine stays the sole owner of the durable state and applies the
decisions a remote worker's replay produces. Types only in this release (no behaviour change); the
engine-side remote executor lands next. See docs/plans/2026-06-15-polyglot-workflows-protocol.md.
