# Track A liveness-rearm — implementation spec (DECIDED: per-run heartbeat)

**Date:** 2026-06-23  **Status:** Design DECIDED (user chose "new per-run heartbeat"). Ready to implement in a fresh budget. Builds on the shipped opt-in self-heal (`@dudousxd/nestjs-durable-core` 0.33.0, commit `b0ab426`).

## Decision
The remote workflow `advance` must distinguish "worker alive, keep waiting" from "worker dead, re-drive" via a **per-run heartbeat**: the worker beats for the run it is currently executing; the engine rearms the advance deadline on each beat. This is safe even for a long *single* step (the worker keeps beating while the step runs), so it never re-drives a legitimately-working turn (no duplicate in-flight-step side effects — the hazard the fixed-timeout half couldn't avoid).

## Why this over the alternatives
- **Streamed step-events** (rejected): silent between events, so a long single handler would be re-driven → dup side effects.
- **Per-worker heartbeat** (rejected): coarse — can't tell if THIS run's worker is the live one vs another run's.

## Reuse the existing remote-STEP heartbeat machinery
The engine already has `awaitWithHeartbeat(id, resultPromise, timeoutMs)` (`packages/core/src/engine.ts` ~2246) used for remote STEPS with a `timeoutMs`: each heartbeat (via `transport.onHeartbeat`) rearms the window. Apply the SAME pattern to the remote workflow advance. The `Heartbeat` wire type already exists (`interfaces.ts` ~430: `{runId, seq, stepId}`) — extend/reuse it for a run-scoped workflow heartbeat (a workflow turn has no `seq`/`stepId`; use `runId` + a sentinel, or add a `kind: 'workflow'`).

## Components (opt-in, default-OFF — zero behavior change unless configured)

1. **Engine** (`packages/core/src/engine.ts`, `runRemoteExecution` ~1550):
   - Add an opt-in `remoteAdvanceSilenceMs` (engine config or the executor's option). When set, wrap the `remote.executor.advance(run, history)` await in a heartbeat-rearmed deadline (mirror `awaitWithHeartbeat`): subscribe to per-run heartbeats for `run.id`; if no beat within `silenceMs`, reject with `RemoteWorkflowTimeout` (the existing class). The existing catch (commit `b0ab426`) already turns `RemoteWorkflowTimeout` → release lease → recovery re-drives. So this slots into the shipped self-heal with no change to the settle path.
   - Default unset = current behavior (the shipped opt-in fixed-`timeoutMs`, or unbounded). 

2. **TS worker** (`packages/worker/src/redis-runner.ts`): while `WorkflowWorker.processTask` runs a turn (it's async; for a long turn add a periodic timer), emit a run-scoped heartbeat on the transport's heartbeat channel every `silenceMs/3`. Stop on turn settle. (The package already streams step-events — add the run heartbeat alongside.)

3. **Python worker** (`clients/python/durable_worker/redis_runner.py`): `process_task` runs in `to_thread`, so the event loop is free — start an `asyncio` task that beats for `task['runId']` every `silenceMs/3` while the thread runs, cancel it when the decision is produced. (Mirrors the existing per-worker `_start_heartbeat`, but run-scoped and only during a turn.)

4. **Transport** (`packages/transport-bullmq`): ensure `onHeartbeat`/the heartbeat publish channel carries run-scoped workflow heartbeats (it already does step heartbeats). The Python + Node workers publish on the same channel the engine's `transport.onHeartbeat` consumes.

## Tests
- Engine: a remote run whose worker beats keeps waiting past `silenceMs` (no timeout); a run that goes silent > `silenceMs` → `RemoteWorkflowTimeout` → re-drives (extend `remote-workflow-timeout.spec.ts`).
- Worker (Node): `redis-runner` emits run heartbeats during a long turn and stops on settle (fake transport, assert beats).
- Python: analogous, the beat task runs during `process_task` and is cancelled after.
- Conformance: a long-running handler (sleep) does NOT get re-driven while the worker beats (the key safety property — no dup side effects).

## Rollout
Opt-in/default-off → ship in a patch. Enable on flip (set `remoteAdvanceSilenceMs` generously, e.g. 60–120s) once both the Node and Python workers emit run heartbeats — then the flip `processing` stuck-run class self-heals in ~`silenceMs` of genuine worker silence, with no dup-side-effect risk for slow handlers.
