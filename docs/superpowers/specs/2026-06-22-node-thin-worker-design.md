# Thin Node/NestJS Durable Worker — Design Spec

**Date:** 2026-06-22  **Status:** Design (awaiting review → writing-plans)
**Repos/packages:** new `packages/worker` (framework-agnostic TS thin worker) + a thin-worker mode in `packages/nestjs`. Consumes the same BullMQ wire protocol as `clients/python/durable_worker`.

## Motivation

The durable engine (`packages/core` / `packages/nestjs` `DurableModule`) is the **control plane**: it owns the store, runs workflows in-process, dispatches remote work, recovers, and serves the dashboard. Today a NestJS app has only two roles via `DurableModule`'s `worker?: boolean`:
- `worker: false` — dashboard/dispatch-only (API pod): mounts the control plane, reads the store, enqueues — does not process/recover.
- `worker: true` — **a SECOND full engine instance**: store access, in-process workflow execution, recovery.

**The problem:** `worker: true` is not a thin worker — it is **another control plane**. Running N of them means N engines contending on the same store and recovery leases. The only true thin worker in the ecosystem is the Python `durable-worker` (no store, no engine — it consumes tasks, runs handlers / replays workflow bodies, and returns `StepResult`/`WorkflowDecision` over BullMQ; the single control-plane engine owns all state).

**Goal:** a **control-plane-less** Node/NestJS worker — the Node analog of `clients/python/durable_worker` — so a plain Node/NestJS service (no DB, no engine, no dashboard) can be a pure worker, symmetric with the Python topology: **one** Nest engine = control plane; **N** thin workers (Python *and* Node) = stateless executors.

## Topology

```
            ┌──────────────────────────┐         BullMQ / Redis
            │  Control plane (1)        │   <prefix>-tasks-<group>  ──▶  thin workers
            │  Nest DurableModule       │   <prefix>-results        ◀──  (StepResult)
            │  store + engine + recovery│   <prefix>-decisions      ◀──  (WorkflowDecision)
            │  + dashboard              │   <prefix>-step-events    ◀──  (live step lifecycle)
            └──────────────────────────┘   <prefix>-control        ──▶  (cancellation)
                 ▲ owns ALL state                 │
                 │                ┌───────────────┼───────────────┐
          thin Node worker(s)     thin Python worker(s)     (future: other SDKs)
          NO store/engine/recovery — consume → run/replay → return over the wire
```

## Locked decision (from discussion)

**Scope = Steps + Workflows (full parity with Python `durable-worker`).** The thin Node worker can own BOTH `@DurableStep` handlers AND `@Workflow` bodies (a TS `processTask` that replays a TS workflow and returns a `WorkflowDecision`), so a Node service can author workflows without a store.

## Key design decision: port, don't reuse

The engine's `createWorkflowCtx` (`packages/core/src/workflow-ctx.ts`) implements the `WorkflowCtx` authoring API in **store-backed** mode — it calls `store.putSignalWaiter/getCheckpoint/saveCheckpoint/getRun/transaction/takeBufferedSignal/...` directly at ~16 sites and suspends by throwing `WorkflowSuspended`. Reusing it for a store-free worker would require a fake store bending every one of those calls — fragile and semantically wrong.

**Decision:** the thin worker uses a **purpose-built TS `WorkflowContext`** that is a faithful port of the proven Python `durable_worker/workflow.py` model — **history in → commands out**, deterministic seq, suspend by throwing an internal `Suspend`. This mirrors the Python worker exactly (the two evolve together) and keeps the worker genuinely store-free. The engine's store-backed ctx and the worker's decision-producing ctx are **two implementations of the same authoring API** — exactly the Python/TS split that already works.

## Components

All in a new framework-agnostic `packages/worker` (`@dudousxd/durable-worker`), plus a NestJS adapter.

### 1. `WorkflowContext` (TS) — `packages/worker/src/workflow-context.ts`
Port of Python's. Constructed with `(runId, history: HistoryEvent[], pendingSignals?, onStep?, isCancelled?)`. Implements the durable authoring ops in decision-producing mode:
- `step(name, body)` — run the body inline, record a `recordStep` command (output/error + events + wall-clock window); replay returns the recorded value without re-running. Mirrors Python `step`.
- `call(name, input, {group})` — record a `call` command + `throw Suspend()`; replay returns the recorded result.
- `sleep(ms)` — record a `sleep` command + suspend.
- `waitSignal(name)` — record a `waitSignal` command (or consume a buffered/pending signal) + suspend.
- `startChild(workflow, input)` / `child(...)` — record a `startChild` command + suspend; replay returns the child's recorded output.
- `all(workflow, inputs, {mode})` — parity with the engine's `ctx.all` and Python `gather_children`: reserve a contiguous seq block, emit N `startChild` commands (tagged `parallelGroup`) in one turn, suspend, resume until all resolve; `waitAll`/`failFast`.
- `gather(items, {mode})` — parity with Python `ctx.gather` (parallel local steps). In Node there are no threads; use `Promise.all` over the bodies with deterministic seq reservation, recording N `recordStep` commands tagged `parallelGroup`. (Determinism: reserve seqs synchronously before awaiting, like the TS `ctx.all`.)
- `now()/random()/uuid()` — checkpointed (recorded once, replayed) like Python.
- Determinism: a single `seq` counter; `_replay(seq, kind, name)` validates kind/name (NondeterminismError) and returns recorded output / re-raises recorded failure; the gather paths use a kind/name-guarded raw read (the fix already landed for the Python side).

### 2. `WorkflowWorker` — `packages/worker/src/workflow-worker.ts`
Port of Python's. `register(name, fn)`; `processTask(task: WorkflowTask): WorkflowDecision` — build a `WorkflowContext` from `task.history`, run the registered body, and map: normal return → `{status:'completed', output, commands}`; `Suspend` → `{status:'continue', commands}`; `Cancelled` → `{status:'cancelled', commands}`; a `StepFailed`/thrown error → `{status:'failed', error, commands}`. Pure and transport-free (testable without a broker), exactly like Python's `process_task`.

### 3. `StepWorker` — `packages/worker/src/step-worker.ts`
`register(name, handler)`; `processTask(task: RemoteTask): StepResult` — run the handler with `(input, log)`, capturing events and wall-clock; map to `{status:'completed'|'failed', output/error, events, startedAt}`. (The engine-side `BullMQTransport` already has a `handle()` consumer; this is the standalone worker's own step executor + result shape so it needs no engine.)

### 4. BullMQ runner — `packages/worker/src/redis-runner.ts`
Mirror of `clients/python/durable_worker/redis_runner.py`: consume `<prefix>-tasks-<group>` (a job is a `WorkflowTask` or `RemoteTask`), run `WorkflowWorker.processTask` / `StepWorker.processTask` **off the main path** (a workflow turn can be long — keep job-lock renewal alive; Node is single-threaded so use the event loop + explicit lock settings, and avoid blocking sync work), publish `WorkflowDecision` on `<prefix>-decisions` / `StepResult` on `<prefix>-results`. Plus: the worker liveness heartbeat key, control-channel cancellation subscribe (feeds `isCancelled`), and streamed step lifecycle on `<prefix>-step-events`. Reuse `transport-bullmq`'s queue/worker plumbing where possible.

### 5. NestJS thin-worker module — `packages/nestjs` (new `DurableWorkerModule` or a `mode: 'thin-worker'`)
Auto-discovers `@Workflow` and `@DurableStep` providers (reuse the existing `workflow.registrar`/`durable-step.registrar` discovery), registers them on the `WorkflowWorker`/`StepWorker`, and starts the BullMQ runner. **No store, no engine, no recovery, no dashboard, no timer poller.** This is the missing first-class "Node app that is only a worker."

## Parity requirement (the core risk)

A `@Workflow`/`@DurableStep` written once MUST behave identically whether executed in-process by the engine (`createWorkflowCtx`, store-backed) or by the thin worker (`WorkflowContext`, history→decision). The two ctx implementations must produce equivalent seq allocation and op semantics. **Mitigation:** (a) port faithfully from the already-proven Python model; (b) a cross-implementation conformance test suite that runs the SAME workflow definitions through both the engine and the thin worker and asserts identical checkpoints/outputs (the wire protocol is the contract — the engine already drives Python workers via exactly these `WorkflowTask`/`WorkflowDecision`/`RemoteTask`/`StepResult` types, so the thin Node worker plugs into the same `remote-workflow.spec.ts`-style harness).

## Out of scope (stay in the control plane)
Store, recovery/`recoverIncomplete`, timers/`resumeDueTimers`, run dispatch/admission, dashboard, singleton admission. The worker never owns state. Ops beyond the Python set (entities, webhooks, `patched`, `continueAsNew`, `transaction`) are follow-ups — v1 mirrors the Python worker's op set + `gather`/`all`.

## Testing strategy
- Unit: `WorkflowContext` determinism (replay returns recorded values without re-running; kind/name nondeterminism guard; gather/all seq reservation), `WorkflowWorker.processTask` decision mapping, `StepWorker.processTask` result mapping — all pure, no broker (mirror the Python `tests/test_workflow_*`).
- Integration: drive a thin Node `WorkflowWorker` from the real `WorkflowEngine` over `InMemoryTransport`/BullMQ (the `remote-workflow.spec.ts` harness already does this for hand-scripted executors — swap in the real `WorkflowWorker`), proving a TS `@Workflow` run by the thin worker settles correctly in the engine.
- Conformance: the same workflow run in-process (engine) vs via thin worker → identical checkpoint sequence + output.

## Relationship to other in-flight work
- Depends on the `parallelGroup` field (landed) and `ctx.all` (landed) for gather parity.
- Independent of Track A (the engine settle/recovery fix), though a thin-worker topology makes Track A's "decision dropped / advance unbounded" path more relevant (more workers, more redelivery surface) — Track A's self-heal should land alongside a real thin-worker rollout.
