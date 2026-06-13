# Durability audit — what shipped and what's next (2026-06-13)

A hardening audit of the engine, prioritising the failure modes that **silently corrupt a durable
run** (the cardinal sin for this kind of system). Items that could be done correctly without new
infrastructure shipped in `core@0.4.0` / `testing@0.2.0` / `otel@0.1.1`. The rest share one root
cause and are designed below rather than half-built.

## Shipped (0.4.0)

| Area | What |
|------|------|
| **Non-determinism detection** | On resume, a step whose `name` no longer matches the checkpoint recorded at that logical position throws `NonDeterminismError` instead of replaying the wrong checkpoint into the wrong step. This is the failure I nearly caused removing a `ctx.step` from the flip pipeline. |
| **Deterministic sources** | `ctx.now()` / `ctx.random()` / `ctx.uuid()` — checkpointed once, replayed verbatim. Workflows that used raw `Date.now()`/`Math.random()` were silently non-deterministic. |
| **Retry backoff** | `backoff: 'fixed' \| 'exp'` + `backoffMs`/`backoffMaxMs`/`jitter`, actually applied between local-step retries (it was a declared-but-ignored option). |
| **Cancellation safety** | `resume()` and `completeRemoteResult()` are no-ops on a cancelled/completed run — a late worker result can't resurrect a finished run. |
| **Replay test harness** | `assertReplayable(register, history)` replays a recorded run against the current code and fails on divergence — a CI guard that catches non-determinism *before* deploy. |
| **Tracing** | Failed steps now emit an OTel span (error status), not just completed ones. |

## Next — all gated on one thing: a distributed control/event channel

The remaining audit items look unrelated but share a root cause: **`EngineEvent`s, heartbeats, and
cancellation are all in-process today.** In a multi-pod deployment (flip: dashboard on the API pod,
runs executing on worker pods) the pod that needs the signal isn't the pod that has it. An
in-process implementation would pass tests and silently do nothing in production — the exact
half-measure to avoid. The unlock is a small **control channel** on the `Transport` (publish/
subscribe, e.g. a Redis pub/sub topic the BullMQ transport already has the connection for):

```ts
interface Transport {
  // new:
  publishControl?(msg: ControlMessage): Promise<void>;     // run.* events, heartbeats, cancel
  onControl?(handler: (msg: ControlMessage) => void): void;
}
```

Once that exists, these fall out of it:

- **#7 SSE live-tail** — the dashboard subscribes to `run.*` control messages and streams them over
  `@Sse('runs/:id/stream')`, replacing polling. (In-process SSE alone is useless cross-pod.)
- **#11 Cooperative cancellation cross-worker** — `cancel()` publishes a `cancel(runId)` control
  message; an in-flight Python/TS worker checks it (`ctx.isCancelled()`) and bails, instead of
  finishing 13min of work that will be discarded. The engine-side discard already shipped (0.4.0).
- **#4 Worker heartbeats over BullMQ** — `ctx.heartbeat()` publishes a heartbeat control message that
  resets the liveness window. Today the BullMQ transport explicitly doesn't model heartbeats (it
  leans on the queue's stalled-job recovery), so `timeoutMs` remote steps have no keep-alive. Lower
  priority: flip uses the durable-suspend path (no `timeoutMs`), so it's unaffected.
- **#6 Distributed tracing across workers** — inject `traceparent` into the `RemoteTask` and have the
  worker (incl. the Python SDK) continue the span, so a remote step shows as a child span in one
  trace. Needs a dispatch-time hook, naturally part of the same plumbing.

## Deferred by design (no current use, real complexity)

- **Sticky execution / replay cache** — avoids the O(n²) re-replay of long histories by keeping the
  workflow in memory between resumes on the same pod. Real win only for workflows with hundreds of
  steps; flip's are short. Wants careful invariants (pod migration, lease handoff) — not worth the
  risk until a workload needs it.
- **`ctx.continueAsNew(input)`** — caps unbounded histories (cron-style/forever workflows) by ending
  the run and starting a fresh one. The lib's `runId` is caller-owned (in flip it's the PipelineRun
  id), so this needs a generation model; no current workflow is unbounded.

## Clarification (#9): `@DurableStep` vs `remoteStep()`

Both define a step that runs on a worker; they're two ends of the same contract, not duplicates:
- `remoteStep({ name, group, input, output })` is the **caller-side** typed handle — the workflow
  does `ctx.call(theStep, input)` and gets a typed result. It carries no implementation.
- `@DurableStep(name)` is the **worker-side** handler that actually runs the work, discovered and
  registered on the transport for its group.
A TS worker uses both (handle + handler in the same app); a cross-language worker (the Python SDK)
implements only the handler, matched by `name`. Worth a doc section; no code change needed.
