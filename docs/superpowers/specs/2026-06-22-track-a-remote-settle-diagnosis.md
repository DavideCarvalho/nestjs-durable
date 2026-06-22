# Track A — Remote workflow stuck `running` after all steps complete: diagnosis + fix design

**Date:** 2026-06-22  **Status:** Diagnosis CONFIRMED (code-level). Engine self-heal needs a design decision (correctness-sensitive).

## Symptom

A durable child run (`workflow=processing`) completes ALL its steps (7 `handle_*`, all `completed`, identical replay timestamps) but the RUN stays `status=running` forever and never notifies its parent. The parent pipeline stays `suspended` on `signal:child:<id>` (kept `running`), holds the per-base singleton, and same-base runs sit `sleeping`. The earlier Redis-localhost bug (flip-python-db `158ac27`, 2026-06-15) is fixed/live — this is a different, residual gap.

## Confirmed root cause

A dropped workflow **decision** combined with an **unbounded await** and a **lease that renews forever**:

1. **No bound on the remote advance.** `RemoteWorkflowExecutor.advance` (`packages/core/src/remote-workflow-executor.ts:65-74`) only rejects on timeout if `opts.timeoutMs` is set — and the executor is constructed without it. So the engine awaits the decision **forever**.
2. **Decisions are correlated by `taskId` in a per-instance, in-memory map** (`remote-workflow-executor.ts:23, 38-44`). A decision with no matching waiter is **silently dropped** (line 39-43). A BullMQ stall+redelivery, or an engine-instance restart spanning the in-memory `pending` map, can land the `completed` decision where no waiter exists → dropped. The steps were recorded (by whichever turn matched), but the run is never settled.
3. **The lease renews forever while the await hangs.** `execute` starts a renew interval (`engine.ts:1447-1455`) and only `clearInterval`s in its `finally` (`engine.ts:1476-1478`). Because `await runRemoteExecution → await advance` never returns, the `finally` never runs → the lease is renewed indefinitely.
4. **Recovery skips lease-held runs.** `recoverIncomplete` (`engine.ts:788-800`) treats a non-acquirable lease as "a live worker owns it" and `continue`s (line 800). So a `running` run whose `advance` promise is dead is **never** re-driven.

Net: child steps all `completed`, child run `running`, parent never notified — an exact match. The Python side already runs `process_task` off-loop via `to_thread` (`clients/python/durable_worker/redis_runner.py:140-152`) to keep the loop free for lock renewal, so the common case doesn't stall; the residual trigger is a real pod pause / GC / instance restart, which the structural gap turns from transient into **permanent**.

## Fix design

### Part B (engine) — the real fix, correctness-sensitive ⚠️

Convert the permanent hang into bounded self-healing: the remote `advance` must reject when the worker is genuinely gone, the run must NOT be marked `failed` on that timeout (it may have completed), the lease must release, and `recoverIncomplete` must re-drive (replay is deterministic/idempotent → the re-driven turn returns the same decision and settles + notifies the parent).

**The hazard that dictates the mechanism:** re-driving re-runs the **in-flight, not-yet-checkpointed step** from scratch. If a timeout fires during *legitimate slow work*, the re-drive **duplicates that step's side effects** (e.g. a DB write). Therefore a **fixed** timeout is unsafe — it cannot tell "slow but alive" from "dead." The bound MUST be **liveness-based**: rearmed by a signal the worker emits while alive.

Available liveness signals (a design choice for the user):
- **Per-worker TTL heartbeat** — `redis_runner.py:69-89` already stamps `durable-worker-heartbeat:<group>:<instance>` every 10s (TTL 35s). It is NOT currently delivered to the engine as a per-run rearm; it is per-worker, not per-run.
- **Streamed step events** — the worker streams each step's `running`/`completed` to the engine (`recordStreamedStep`, `engine.ts:1273`). Per-run, but sparse during a single long step.
- **A new per-run workflow heartbeat** — the worker beats for the run it is currently executing; cleanest per-run liveness, requires a small Python + transport addition.

**Proposed shape:** add an engine-level `remoteAdvanceSilenceMs` (config, generous default) tracked per running remote run, rearmed on any liveness signal for that run; on silence > window, `advance` (or an engine-side race) rejects with a new `RemoteWorkflowTimeout`; `runRemoteExecution`'s catch (`engine.ts:1551-1559`) distinguishes `RemoteWorkflowTimeout` (release lease, return `suspended` → recovery re-drives) from a genuine executor error (fail, as today). The `executionTimeout` reaper remains the absolute upper bound.

**Decision needed from the user:** which liveness signal, and the silence window (self-heal latency vs. tolerance for long single steps). This is why it isn't shipped blind.

#### SHIPPED — safe, opt-in, default-OFF half (2026-06-22)

The *recoverable-timeout* mechanism is now in the engine, gated entirely on the executor's existing
`timeoutMs` (caller-configured; absent = prior unbounded await, unchanged → existing users see zero
behavior change):

- New `RemoteWorkflowTimeout extends Error` (`packages/core/src/errors.ts`) carrying `taskId` + `timeoutMs`.
- `RemoteWorkflowExecutor.advance` (`remote-workflow-executor.ts`) now rejects the timeout with
  `RemoteWorkflowTimeout` instead of a generic `Error`.
- `runRemoteExecution`'s catch (`engine.ts`) distinguishes it: on `RemoteWorkflowTimeout` it RELEASES
  the run lease (`releaseRunLock`, idempotent) and returns the run's current status WITHOUT marking it
  failed — so the run stays `running`/`suspended` and `recoverIncomplete` re-acquires the now-free lease
  and re-drives it (deterministic replay → same `completed` decision → settle → notify parent). Any
  OTHER error still fails the run (unchanged). `execute`'s `finally` clears the renew interval once the
  call returns, so the released lease genuinely stays free (a renew tick racing the release is a no-op
  because `renewRunLock` requires `lockedBy === owner`).
- Tests: `packages/core/src/remote-workflow-timeout.spec.ts` (stuck-without-timeout bug, timeout→
  recovery→completed, parent notified, non-timeout error still fails).

**KNOWN LIMITATION (the still-open hazard):** a fixed timeout that fires while a worker is LEGITIMATELY
still executing a not-yet-checkpointed step re-drives and re-runs that in-flight step → **duplicate side
effects**. So this opt-in timeout is only safe when set GENEROUSLY (> the longest legitimate single
turn). It does NOT distinguish "slow but alive" from "dead."

#### NEXT STEP (follow-up, NOT yet implemented) — the liveness-rearmed deadline

The robust fix is to make the deadline **liveness-based** rather than fixed: rearm it on any per-run
liveness signal the worker emits while alive (see the three signals above), so only a *genuinely dead*
worker ever crosses the silence window and re-drives. That removes the duplicate-side-effect hazard and
lets the window be tightened for faster self-heal. This is the open work; the shipped opt-in timeout is
the conservative interim.

### Part A (Python) — safe interim hardening (low-risk)

Pass an explicit, generous `lockDuration` (and matching stalled settings) to the workflow `BullWorker` (`redis_runner.py:155`) so a transient loop pause is less likely to lapse the lock and trigger a stall/redelivery in the first place. Reduces trigger frequency; does not by itself fix the permanent-hang structural gap (Part B does).

## Cheapest confirmation

- **Dev (zero code):** for the stuck child run, check `lockedUntil` on `durableWorkflowRun` — the diagnosis predicts a continuously-future `lockedUntil` (lease still renewing), which is why `recoverIncomplete` skips it (`engine.ts:800`). Check the `durable-decisions` queue for an orphaned decision whose `taskId` has no waiter.
- **Unit (nestjs-durable):** in an engine/remote-executor spec, deliver the `completed` decision with a `taskId` that has no live waiter (`remote-workflow-executor.ts:39`); assert the run stays `running` and `notifyParent` is never called today — then assert the proposed timeout→re-drive settles it and notifies the parent.
