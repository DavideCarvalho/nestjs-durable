---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
---

Re-drive a `gather_calls` step whose worker was killed mid-step, instead of orphaning it forever.

A polyglot workflow's turn declares its fan-out as `call` commands; `applyCommands` writes a
`pending` checkpoint and dispatches each one. On every later turn the worker's replay RE-EMITS
the calls it is still waiting on, and the engine skips a command whose checkpoint already
exists — the guard that stops a partially-settled fan-out from double-dispatching its live
siblings.

That guard had no notion of a LOST job. A worker OOM-killed mid-step takes its in-flight job
with it, and for a non-TS consumer nothing bridges the job's terminal failure back into a
`StepResult` (the TypeScript transport has always done this; the Python SDK did not, which is
why a Python fleet's steps orphan where a Node fleet's do not — fixed on that side too, in
`durable-worker`). The checkpoint therefore stayed `pending` — "out for delivery" — and every
turn skipped it: the run woke on the `reconcileMs` sweep, dispatched a turn, had the calls
re-emitted, skipped them, and slept. Forever. Observed on a six-run fan-out: `pending`,
`attempts = 1`, checkpoint `wakeAt` NULL, over an hour, no retry, while sibling steps
dispatched in the same batch completed normally on the restarted worker.

The two tells name the gap exactly. `callRemote` (the `ctx.step` path) stamps a re-dispatch
deadline on the pending checkpoint's `wakeAt` and honours `remoteRedispatchMs`; the `call` path
did neither — so the documented lost-dispatch self-heal **did not exist for a fan-out**, no
matter how it was configured.

Now the two paths share one policy, and a pending remote checkpoint's `wakeAt` means the same
thing in both: the step's LEASE.

- A settled checkpoint always wins — a step that completed just before the crash is never re-run.
- `remoteRedispatchMs` unset (still the default) keeps the by-design "re-suspend, never
  re-dispatch": a merely-slow worker is never double-run.
- Set it and the dispatched step carries a lease, and the run suspends ON it (never later than
  the `reconcileMs` sweep would have woken it anyway). Only a LAPSED lease re-dispatches,
  bounded by `remoteRedispatchMax` (default 10); past the bound the step is failed
  `remote_step_lost`, which enters the run's history so the workflow's own error path surfaces
  it rather than the engine looping.
- A step-scoped heartbeat now RENEWS that lease durably (`{ runId, seq, stepId, group }` on the
  heartbeat channel), so a worker still holding a long step keeps it — the in-memory rearm only
  ever protected a `timeoutMs` step, and only on the instance that dispatched it.
- Observability: a re-drive emits `step.started` with `redispatched: true` and appends a `warn`
  `step.redispatched` event to the checkpoint's own trail (`step.lost` at the bound), so
  "re-driven after a lost worker" reads differently from a failure retry — in the dashboard and
  in the database.

`DurableModule` also **forwards `remoteRedispatchMs` / `remoteRedispatchMax`** for the first
time. They were engine-only options the Nest module never passed on, so every consumer wiring
the engine through `DurableModule` was stuck with the orphan-forever default regardless of what
it set.
