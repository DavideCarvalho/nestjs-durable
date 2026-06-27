---
"@dudousxd/nestjs-durable-core": minor
---

Add parallel remote steps: `ctx.gather_calls([...])` (Python SDK) dispatches N remote steps in parallel within ONE run — each durably checkpointed and idempotent — tagged with a shared `parallelGroup` so they render as a flat parallel fan (no child runs).

Engine support for the `call` command:
- **Idempotency:** before persisting + dispatching a `call`, skip when a checkpoint for `(runId, seq)` already exists (pending or terminal). A `gather_calls` fan-out re-emits its still-pending calls on every partial resume, so this prevents a re-emitted call from being double-dispatched (mirrors the `startChild` guard). The result lands independently via `completeRemoteResult`, keyed by seq, so concurrent in-flight calls never clobber each other.
- **parallelGroup:** the `call` command now carries an optional `parallelGroup`, threaded onto the remote step's checkpoint so the dashboard groups the fan vertically (parity with the gathered `recordStep` / `startChild` tags).

The Python `durable-worker` SDK ships separately to PyPI (tag `durable-worker-v*`), so its version bump is not changeset-managed.
