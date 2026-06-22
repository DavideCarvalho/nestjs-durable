# Durable Parallel `gather` Primitive — Design Spec

**Date:** 2026-06-22
**Status:** Design (awaiting review → writing-plans)
**Repos touched:** `durable-worker` (Python lib), `nestjs-durable` (TS lib), `flip-python-db` (consumer), `flip-nestjs` (`/durable` dashboard)

---

## Goal

Add a deterministic **parallel `gather`** primitive to the durable workflow libraries so a workflow can run N units of work concurrently and **wait for all results**, with the result of each influencing whether the run succeeds or fails. First consumer: the flip `processing` workflow, whose 7 `handle_*` handlers run **sequentially** today and should run in parallel.

## Background / Problem

- The Python `processing` workflow (`flip-python-db/app/durable_processing_workflow_worker.py`) runs the 7 handlers (`AF_FLEET, MEL, METADATA, MVR, SCHED_MX, SUBWO, UTIL`) in a `for` loop of `ctx.step(...)` — **strictly sequential**. Each run is ~7× slower than it needs to be.
- The durable libs have **no parallel-and-wait-all primitive**:
  - **Python `durable-worker` 0.10.0** `WorkflowContext` exposes only `step` (inline, sequential), `sleep`, `wait_signal`, `call` (remote, suspend), and `start_child` (dispatch **and await** one child — its docstring: *"Start a child run and await its output"*). Calling `start_child` N times in a row is **sequential** (each suspends before the next starts).
  - **TS `nestjs-durable`** has `ctx.startChild` (fire-and-forget, returns id, no suspend) and `ctx.child` (await one), but **no `ctx.all`** that scatters N then gathers all.
- Secondary benefit: a workflow that fans work out and a stuck child currently hangs the parent (suspended on `signal:child:<id>`), which on the pipeline holds the per-base singleton and blocks same-base runs. (The current production hang has a separate root cause — see **Track A** — but parallel semantics are part of the long-term shape.)

## Locked Decisions

1. **Scope:** parallelize the 7 `handle_*` **inside** `processing`. The pipeline keeps awaiting the `processing` child as a whole.
2. **Two variants, both implemented in the libs:**
   - `gather` over **local step bodies** (threads, one run) — **used by `processing` now** (P2).
   - `gather` over **child workflows** (N child runs) — implemented for parity, **not consumed yet** (P1).
3. **Failure modes — both supported, via a `mode` argument:**
   - `wait_all` (**default**, used by `processing`): wait for all to settle, record every outcome, then raise if any failed.
   - `fail_fast`: raise on the first failure **and signal cooperative cancellation** to the siblings still running.
4. **Fire-and-forget on Python:** **not added now** (YAGNI — nothing consumes it; TS already has `startChild`).
5. **Spec lives in `nestjs-durable`. Implementation order:** Python `durable-worker` `gather` → `processing` consumes it → `/durable` viz → TS `nestjs-durable` parity. **Track A** (recovery/settle bug) runs in parallel as an isolated fix.

## Global Constraints

- **Determinism is non-negotiable.** Same code + same history ⇒ same seqs ⇒ same decisions. `gather` must allocate a **contiguous, list-order block of seqs** so replay is stable. Adding/removing a `gather`, or reordering its items, is a workflow-version change for in-flight runs (same rule as any op-count change).
- **No engine schema change required for v1.** `gather` composes existing checkpoint kinds. The only additive metadata is a `parallelGroup` marker on the grouped checkpoints (optional field; absent ⇒ renders as today).
- **Backwards compatible:** existing workflows and the existing `/durable` timeline render unchanged when no `parallelGroup` is present.
- Handlers in the `processing` gather are **DB/IO-bound** — thread-based parallelism is effective (GIL releases on IO); this primitive is **not** for CPU-bound parallelism.

---

## Primitive Contract

### Python `durable-worker`: `ctx.gather`

```python
# P2 — local step bodies in parallel (the processing use case)
results = ctx.gather(
    [
        ("handle_AF_FLEET", lambda: handle_af_fleet(eng, base_id, task_id)),
        ("handle_MEL",      lambda: handle_mel(eng, base_id, task_id)),
        # ... 7 total, in canonical order
    ],
    mode="wait_all",  # default
)
# results: list aligned to input order; each is the handler's return value
```

```python
# P1 — child workflows in parallel (parity; not consumed yet)
results = ctx.gather_children(
    "handle",                       # child workflow name
    [input_af_fleet, input_mel, ...],
    mode="wait_all",
)
```

**Semantics (both variants):**

- **Seq allocation:** the gather reserves `len(items)` consecutive seqs from `_next()` in list order, before running/dispatching anything. This is the determinism anchor.
- **`gather` (steps):** runs each body in a worker **thread** (mirrors the existing `blocking=True` step path), records each as a `recordStep` command at its reserved seq with a `parallelGroup` tag, **does not suspend** (steps are inline in the model). Returns when all threads have joined.
- **`gather_children` (children):** appends N `startChild` commands at the reserved seqs **in one turn** (so all children dispatch and run concurrently on the worker pool), then `raise _Suspend()` **once**. On each child completion the parent resumes, `_replay` returns the now-resolved seqs, and the gather re-suspends until **all** seqs resolve, then returns the outputs.
- **Replay:** on replay each reserved seq is resolved from `_history` (output or recorded error); a resolved-failed seq raises per `_replay`.
- **Result order:** always input order, regardless of completion order.

**`mode="wait_all"` (default):**
- Wait for every item to settle (success or failure).
- Record all outcomes.
- If ≥1 failed, raise an aggregate error (`GatherFailed` carrying the per-item errors) → the workflow fails → its parent (the pipeline `ctx.child("processing")`) observes the failure.
- **Retry property:** on a workflow retry, the completed seqs replay from history; **only the failed item(s) re-run**.

**`mode="fail_fast"`:**
- On the first item failure, signal **cooperative cancellation** to the still-running siblings and raise.
- Cancellation uses the existing machinery: a gather-local `threading.Event` exposed through each thread's `StepContext.is_cancelled` (OR'd with the run-level cancel from `cancellation.py`). Handlers that check `current_step().cancelled` bail at their next checkpoint; handlers that don't, run to completion (cooperative — **no forced thread kill**, threads doing DB work are not interruptible mid-call).
- For `gather_children`, fail_fast best-effort cancels the sibling child **runs** via the control-channel cancellation broadcast.

### TS `nestjs-durable`: `ctx.all` (parity)

```ts
// Parity with Python gather_children — scatter N children, wait all, ordered results.
const results = await ctx.all(workflow, inputs, { mode: "waitAll" }); // default
```

- Composes the existing `startChild` (scatter all N first — they all dispatch and run concurrently) + `child(sameId)` join (gather), which the existing code already documents as *"start + join scatter-gather."*
- Allocates a contiguous seq block; suspends once per outstanding child until all resolve; returns ordered results.
- `mode: "failFast"` mirrors Python: rejects on first child failure and best-effort cancels the siblings.
- A TS local-step gather (parity with Python P2) is **out of scope for v1** unless a TS consumer needs it (YAGNI); the children variant is the parity target.

---

## `/durable` Dashboard Visualization

- Grouped checkpoints carry `parallelGroup = <groupId>` (stable per gather call: derived from the run id + the gather's base seq).
- The timeline renderer groups consecutive checkpoints sharing a `parallelGroup` into one **fan node** labelled `<workflow/label> ×N` (e.g. `processing ×7`).
- Expanded, the fan shows the N branches **side by side at the same depth**, each with its own live status and duration — not the current vertically-stacked sequential list.
- Absent `parallelGroup` ⇒ unchanged sequential rendering. No change to non-parallel runs.

---

## flip `processing` Consumption (P2)

Replace the sequential `for` loop in `durable_processing_workflow_worker.py` with a single `ctx.gather([...])` over the 7 `(label, handler)` pairs in the existing canonical order (`_ALL_HANDLER_ORDER`). The `pri_buy_allocation` special-case (passing the workflow input as `body`) is preserved inside its lambda. `mode="wait_all"` so any handler failure fails the run and propagates to the pipeline. The merged-context return shape (`{"context": merged}`) is unchanged.

For `proc != "all"` (single handler), `gather` of one item must behave identically to today's single `ctx.step` (a one-item gather is a valid degenerate case).

---

## Track A — Recovery / settle bug (separate workstream, runs in parallel)

**Not part of the gather primitive.** Diagnosis to date:
- The historical "every `ctx.child('processing')` parent hangs in `running`" was the processing worker falling back to `localhost:6379` Redis → never consumed the group. **Fixed** in `flip-python-db@158ac27` (2026-06-15), live.
- Current stuck runs (e.g. `019ef093`): the child completed all 7 steps (identical timestamps ⇒ fast **replay**, i.e. it **was** redelivered) but the run never settled to terminal. Recovery in `durable-worker` is **BullMQ stalled-job redelivery** (lock renewal). The symptom points at the **post-replay completion / job-ack path** (a window between acking the job and marking the run completed), not absent recovery.
- **Next:** read the decision/complete handling in `durable_worker/worker.py`, confirm the ack-vs-complete ordering, and verify against live dev (did any pipeline complete after 2026-06-20; are orphaned `running` runs re-claimed). Fix lands in `durable-worker`.

---

## Testing Strategy

- **Determinism:** a `gather` of N, then a suspend/resume (e.g. a following `sleep`), replays to identical seqs and identical results. Reordering items is detected as nondeterminism.
- **wait_all failure:** one item raises ⇒ all others still recorded ⇒ `GatherFailed` carries the one error ⇒ retry re-runs only the failed item (assert the completed items are NOT re-executed — e.g. side-effect counter).
- **fail_fast:** first failure ⇒ siblings receive the cancel signal; a cooperative handler observes `cancelled` and bails; raise is prompt.
- **Ordering:** results align to input order under shuffled completion order.
- **Degenerate:** one-item gather == single step (same checkpoint shape, same result).
- **Parity:** TS `ctx.all` over children matches the Python `gather_children` semantics (scatter-once, ordered, wait-all default, failFast cancel).
- **Viz:** a run with a `parallelGroup` renders one fan node with N same-level branches; a run without renders unchanged (snapshot/visual check on `/durable`).

## Self-Review Notes

- **Spec coverage:** both variants, both failure modes, determinism, viz, the flip consumer, and the parity target are each specified. ✅
- **Ambiguity resolved:** fail_fast is explicitly **cooperative** (no thread kill); wait_all is the processing default; one-item gather is defined. ✅
- **Scope/YAGNI:** Python fire-and-forget and a TS local-step gather are explicitly deferred. Track A is fenced off as a separate fix. ✅
