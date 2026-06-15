# Sub-process lifecycle (flip consumer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make flip's durable v2 `/durable` dashboard show each p-process as a distinct, expandable lifecycle row — by emitting per-p-process **run identity + handler group + phase transitions** into the durable step events, and by splitting the single `processing` step into **one durable step per handler**.

**Architecture:** Three components in dependency order. (A) The lib's **Python SDK** (`clients/python/durable_worker`, in the nestjs-durable repo) gains a `sub_event`/phase API mirroring the TS `subEvent` shipped in the lib feature. (B) **flip-python-db** uses it: `PProcess.run()` already mints a `processRunId` and knows its `handler_name` — wire those (+ phase transitions) into the durable sink. (C) **flip-nestjs** splits `planPProcesses` so an `"all"` run enqueues one `ctx.call(processingStep)` per handler instead of one `proc:"all"` call, and bumps the lib version.

**Tech Stack:** Python (pytest), the `durable_worker` Python SDK, TypeScript/NestJS (vitest), `@dudousxd/nestjs-durable-*`, BullMQ transport.

**Upstream:** Lib TS feature (StepEvent `subId`/`group`/`phase` + `StepLogger.subEvent` + dashboard accordion) is DONE and merged to `main` (commit `aed6c65`), pending changesets release. Design: `docs/plans/2026-06-15-extensible-subprocess-lifecycle.md`. Lib impl: `docs/plans/2026-06-15-subprocess-lifecycle-lib-impl.md`.

---

## ⚠️ Coordination & sequencing (read first)

- **Component A (Python SDK `sub_process`/`sub_event`) is DONE and on `main`** (`clients/python/durable_worker`), pending a PyPI release (tag `durable-worker-v0.6.0`). The TS dashboard feature is also released. So the remaining work is: cut the Python release (A2), then B (flip-python-db) and C (flip-nestjs).
- **Dependency order:** A is done → **B depends on A being released to PyPI** (flip-python-db installs `durable_worker>=0.6.0`). **C-split (handler-as-step) is INDEPENDENT** of the lib release — it only restructures flip-nestjs + relies on Python's existing `file_type_proc_map`, so it can ship first and stand alone.
- **The double-dispatch bug is OUT OF SCOPE** (af_fleet/mel/metadata running 2×). Run identity + handler-as-step make it *display* correctly (distinct steps/rows); they don't stop the double execution. Separate investigation.

---

## Component A — Python SDK: `sub_event` + `sub_process` context manager ✅ DONE (on `main`, unreleased)

**Implemented and merged to `main`** (`clients/python/durable_worker`). Davi asked for an ergonomic API, so beyond the flat primitive there's a context manager. Shipped surface:

```python
from durable_worker import sub_process, sub_event

# Ergonomic (recommended): context manager — auto run-id, auto durationMs, ok on clean exit /
# failed on exception (re-raised) / skip(), logs inside auto-tagged to this sub's run id. No-op
# outside a durable step, so the same business code runs unchanged on a non-durable path.
with sub_process("ProcessKpi", group="AF_FLEET") as sp:
    sp.phase("validating")
    if not valid:
        sp.skip("; ".join(errors)); return
    sp.phase("processing")
    ...  # work; durable_worker.log(...) here is tagged with this run id
# clean exit -> terminal "ok" + measured durationMs

# Flat primitive (mirrors TS StepLogger.subEvent 1:1) — when you manage the id yourself:
sub_event(id="r1", name="ProcessKpi", group="AF_FLEET", phase="processing")
sub_event(id="r1", name="ProcessKpi", group="AF_FLEET", status="ok", data={"durationMs": 42})
```

Under the hood: `StepContext._emit` extended with `sub_id`/`group`/`phase` (emitting camelCase `subId`/`group`/`phase`); `StepContext.sub_event` + module-level `sub_event`; `_SubProcess` context manager (`__enter__`/`__exit__` with `try/finally` state restore, monotonic duration, `.phase()`/`.skip()`/`.fail()`); log lines auto-stamp `subId` from the current sub. Existing `sub()`/`log()`/`set_process()` unchanged — a legacy `sub("x","ok")` still emits no `subId`. Tests in `clients/python/tests/test_sub_process.py` (9). The dashboard already consumes `subId`/`group`/`phase` (TS feature shipped).

### Task A2: Release the Python SDK to PyPI (tag-triggered — NOT changesets)

The Python SDK releases via `.github/workflows/release-python.yml`, triggered by pushing a tag `durable-worker-v*` (or manual `workflow_dispatch`) → builds + publishes to PyPI via OIDC Trusted Publishing.

- [ ] **Step 1:** Bump the version in BOTH `clients/python/pyproject.toml` (`version`) and `clients/python/durable_worker/__init__.py` (`__version__`) from `0.5.0` → `0.6.0` (minor — additive feature). Commit to `main`.
- [ ] **Step 2:** Push the tag `durable-worker-v0.6.0` to trigger the publish workflow (ASK first — this is the deliberate "publish" action). Confirm the workflow succeeds and `0.6.0` is on PyPI.

---

## Component B — flip-python-db: emit run-id + group + phases

`PProcess.run()` (`app/common/interface/p_process.py`) already: mints `process_run_id = str(uuid.uuid4())` (line ~20), receives `handler_name`, emits v1 SQS lifecycle (TRIGGERED/VALIDATING/PROCESSING/NOT_VALID/COMPLETED/ERROR), and already calls the durable sink `set_current_process(name)` (line ~40) + `emit_subprocess(name, status, msg, {"durationMs": …})` (lines ~102/143/170). The durable worker imports these as `from durable_worker import set_process as set_current_process, sub as emit_subprocess` (`app/durable_processing_worker.py` lines 10-12).

**Goal:** route the EXISTING `process_run_id` + `handler_name` + phase transitions into the durable sink via the new `sub_event` API, so the dashboard groups by run id and shows the lifecycle. **Requires Component A released and installed** (bump the `durable_worker` dependency in `flip-python-db`).

**Files:**
- Modify: `app/durable_processing_worker.py` (import `sub_event`)
- Modify: `app/common/interface/p_process.py` (emit phases + terminal via `sub_event`, keyed by `process_run_id`, grouped by `handler_name`)
- Modify: `app/common/durable_proc_events.py` (extend the sink shim + `EventSink` Protocol to expose `sub_event` and a run-id-aware `set_current_process`)
- Test: `tests/test_observable.py` / a new `tests/test_durable_proc_events.py`

Component A's context manager makes this much thinner than originally drafted — `PProcess.run()` wraps its body in `with sub_process(...)`, which handles run-id, duration, terminal status (incl. exception→failed), and log tagging automatically. The custom `emit_subprocess`/`emit_subphase` shim is largely unnecessary now.

### Task B1: Re-point the durable sink shim at the SDK's `sub_process`/`sub_event`

`app/common/durable_proc_events.py` currently wraps a context-local `EventSink` with `emit_subprocess`/`emit_log`/`set_current_process`. Simplify:
- [ ] Re-export (or thinly wrap) `sub_process` and `sub_event` from `durable_worker` so p-process code imports one place. The SDK functions are already no-ops outside a durable step, so the existing "cheap no-op on the v1 SQS path" property is preserved for free — you can drop the custom contextvar sink if nothing else needs it (verify no other caller depends on the old `EventSink`/`set_sink` API first).
- [ ] Keep `emit_log` (maps to `durable_worker.log`) if p-process step code still emits free log lines.
- [ ] Tests: assert `sub_process`/`sub_event` are no-ops with no current step (v1 path) and forward correctly under a fake step context.

### Task B2: Wrap `PProcess.run()` in `with sub_process(...)`

- [ ] Replace the manual durable emissions in `PProcess.run()` with a single `with sub_process(self.__class__.__name__, group=handler_name, id=process_run_id) as sp:` around the run body. Pass the EXISTING `process_run_id` as `id` (so durable + v1 SQS share one run identity) and `handler_name` as `group`. Inside: `sp.phase("validating")`; on validation failure `sp.skip("; ".join(validation_errors)); return`; then `sp.phase("processing")`; the clean exit auto-emits `ok` (+ durationMs); an exception auto-emits `failed` and re-raises. Drop the now-redundant `set_current_process(...)`/`emit_subprocess(...)` calls (the CM tags logs + emits the terminal). Keep the v1 SQS lifecycle sends as-is (unchanged — they feed the v1 dashboard).
- [ ] Confirm duration parity: the CM measures monotonic enter→exit; if you must keep the existing `elapsed_ms()` number on the terminal, pass it via `sp.skip(..., data={"durationMs": elapsed_ms()})` / `sp.fail(..., data={...})` (the CM preserves a caller-supplied `durationMs`).
- [ ] Tests (`tests/test_observable.py` style — drive a fake PProcess under a fake durable step; assert the emitted events are: phase `validating`, phase `processing`, terminal `ok`, all sharing `subId == process_run_id` and `group == handler_name`; plus the validation-failure→`skipped` and exception→`failed` paths).

### Task B3: Bump the `durable_worker` SDK dependency

- [ ] Bump `flip-python-db`'s `durable_worker` dependency to `>=0.6.0` (the Component A release). Run the durable worker tests.

---

## Component C — flip-nestjs: handler-as-step + lib bump

### Task C1: Split `planPProcesses` so `"all"` enqueues one step per handler

This is INDEPENDENT of the lib release — Python's `file_type_proc_map` already supports each `*_dep_procs` proc individually; we stop sending `proc:"all"` (which runs all 7 handlers in one step) and send the 7 handler procs instead, so the workflow's existing `for (const body of plan) await ctx.call(processingStep, body)` loop creates one durable step per handler.

**Files:**
- Modify: `src/defense/us/service/readers/file/readers/file-upload.service.ts` (`planPProcesses`, the `processDictionary`)
- Test: a new spec for `planPProcesses` (vitest)

- [ ] **Step 1: Write the failing test.** Create a focused unit test for `planPProcesses` (instantiate the service with stubbed deps, or extract the `processDictionary` mapping to a pure exported function and test that). Assert that `type="all"` yields one body per handler proc (the 7 `*_dep_procs` + metadata), each `{ proc: "<handler proc>", base_id, task_id, context }`, and that a single-type upload (e.g. `"mel"`) still yields exactly `[{ proc: "mel_dep_procs", … }]`.

  > IMPORTANT — confirm the exact handler proc list with flip-python-db's `file_type_proc_map` (`app/p_process_queue_listener.py`): `subwo_dep_procs`, `util_dep_procs`, `af_dep_procs`, `mvr_dep_procs`, `mel_dep_procs`, `mx_dep_procs`, and the metadata/stats procs that `handle_all_processes` runs (`metadata_generation`? confirm — `handle_all_processes` runs af/mel/metadata/mvr/sched_mx/subwo/util). The `"all"` expansion must enumerate exactly the procs `handle_all_processes` would have run, in the same order, so behavior is preserved.

- [ ] **Step 2:** Run it, see it fail.
- [ ] **Step 3: Implement.** Change the `processDictionary` `all` entry from `["all"]` to the ordered list of the per-handler procs that `handle_all_processes` runs. Keep every other type unchanged. Keep `pribuy_model` as `["pri_buy_allocation"]`.
- [ ] **Step 4:** Run the test, see it pass. Run `pnpm build && pnpm test` for the touched area.
- [ ] **Step 5: Verify ordering & cancellation semantics.** The workflow loop is sequential (`for … await ctx.call`), preserving handler order. Confirm no inter-handler data dependency exists that `handle_all_processes` relied on beyond ordering (read `handle_all_processes`); document the finding in the PR. Durable cancel replaces the Python `_check_cancel_requested` between handlers — confirm a cancel between steps still halts the run.
- [ ] **Step 6: Commit.**

> Note: with handler-as-step, each handler is a distinct durable step, so a handler that double-dispatches shows as two steps (not a merged blob) — and `_emit_handler_expected_count` (Python) still fires per handler. The per-handler `processingStep` output `{context}` continues to merge in the workflow loop unchanged.

### Task C2: Bump `@dudousxd/nestjs-durable-*`

- [ ] Bump the durable lib deps to the released version (the one from the lib feature + Component A). Run `pnpm build → codegen → typecheck` per flip-nestjs's build order. Commit.

---

## Self-Review

**Spec coverage** (against the design `2026-06-15-extensible-subprocess-lifecycle.md`):
- Run identity per p-process → reuse existing `process_run_id` as `sub_event.id` (B2). ✓
- Open `group` = handler → `handler_name` as `group` (B2); but note handler-as-step (C1) makes the step itself the handler boundary, so `group` is belt-and-suspenders. ✓
- Open phases (triggered/validating/processing) + terminal closed status → B2 emits them; A provides the API. ✓
- Discrete live events → each phase is its own `sub_event`, streamed via the step's event channel (dashboard already merges `step.progress`). ✓
- Handler-as-step restructuring → C1. ✓
- Python SDK mirrors TS `subEvent` → A. ✓
- Double-dispatch out of scope → stated. ✓

**Placeholder scan:** Phase A's exact test-runner command and the Python-release mechanism are intentionally "confirm from `pyproject.toml`/prior releases" because the SDK is actively changing under a concurrent session and its release tooling must be read fresh at execution — this is a deliberate re-verify instruction, not a vague TODO. The `"all"` proc list (C1) is pinned to flip-python-db's `file_type_proc_map` + `handle_all_processes` order — confirm the exact set at execution.

**Type/name consistency:** `sub_event(id, name, group?, phase?, status?, message?, data?)` (Python A) mirrors the TS `subEvent` signature exactly; emitted JSON keys `subId`/`group`/`phase`/`name`/`status` match the dashboard's `StepEvent`. `process_run_id` (Python) → `subId` (event) → `SubProcess.id` (dashboard). `handler_name` → `group`.

**Open items to resolve at execution (not blockers, but verify):**
1. Phase A: current shape of `worker.py` after the concurrent session's changes; the SDK release mechanism.
2. B1: what the SDK's log-tagging hook keys on post-A (name vs subId) — align `set_current_process`.
3. C1: the exact ordered proc list `handle_all_processes` runs, to preserve behavior.
