# Sub-process lifecycle (flip consumer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make flip's durable v2 `/durable` dashboard show each p-process as a distinct, expandable lifecycle row — by emitting per-p-process **run identity + handler group + phase transitions** into the durable step events, and by splitting the single `processing` step into **one durable step per handler**.

**Architecture:** Three components in dependency order. (A) The lib's **Python SDK** (`clients/python/durable_worker`, in the nestjs-durable repo) gains a `sub_event`/phase API mirroring the TS `subEvent` shipped in the lib feature. (B) **flip-python-db** uses it: `PProcess.run()` already mints a `processRunId` and knows its `handler_name` — wire those (+ phase transitions) into the durable sink. (C) **flip-nestjs** splits `planPProcesses` so an `"all"` run enqueues one `ctx.call(processingStep)` per handler instead of one `proc:"all"` call, and bumps the lib version.

**Tech Stack:** Python (pytest), the `durable_worker` Python SDK, TypeScript/NestJS (vitest), `@dudousxd/nestjs-durable-*`, BullMQ transport.

**Upstream:** Lib TS feature (StepEvent `subId`/`group`/`phase` + `StepLogger.subEvent` + dashboard accordion) is DONE and merged to `main` (commit `aed6c65`), pending changesets release. Design: `docs/plans/2026-06-15-extensible-subprocess-lifecycle.md`. Lib impl: `docs/plans/2026-06-15-subprocess-lifecycle-lib-impl.md`.

---

## ⚠️ Coordination & sequencing (read first)

- **Phase A edits `clients/python/durable_worker/` in THIS lib repo, which a concurrent session is actively developing** (the "polyglot workflow protocol + Python replay runtime" work, `ed4a429`…`69db236`). Before starting Phase A: re-read the current `worker.py`/`__init__.py` (they may have moved since this plan was written at SDK `__version__ = "0.5.0"`), and coordinate so the two efforts don't stomp each other. Do Phase A on its own branch.
- **Dependency order:** A (Python SDK, lib release) → C-bump depends on the TS+Python release; **B depends on A being released** (flip-python-db installs the SDK). **C-split (handler-as-step) is INDEPDENDENT** of the lib release — it only restructures flip-nestjs + relies on Python's existing `file_type_proc_map`, so it can ship first and stand alone.
- **The double-dispatch bug is OUT OF SCOPE** (af_fleet/mel/metadata running 2×). Run identity + handler-as-step make it *display* correctly (distinct steps/rows); they don't stop the double execution. Separate investigation.

---

## Component A — Python SDK: `sub_event` + run-identity/group/phase

The TS `StepLogger.subEvent({ id, name, group?, phase?, status?, message?, data? })` emits a `StepEvent` with `subId`/`group`/`phase` keys. The Python SDK must emit the **same camelCase keys** so the dashboard reads them identically. Today (`clients/python/durable_worker/worker.py`, v0.5.0): `StepContext._emit(level, message, *, name=None, status=None, process=None, data=None)` builds the event dict and appends to `self.events`; `StepContext.sub(name, status, message, data)` calls `_emit(...)`; module-level `sub`/`log`/`set_process` delegate to the context-local current step.

**Files:**
- Modify: `clients/python/durable_worker/worker.py` (`StepContext._emit`, add `StepContext.sub_event`, module-level `sub_event`)
- Modify: `clients/python/durable_worker/__init__.py` (export `sub_event`)
- Test: `clients/python/tests/test_worker.py`
- Changeset: `.changeset/python-sub-event.md`

### Task A1: Extend `_emit` to carry `subId`/`group`/`phase`

- [ ] **Step 1: Re-read current `worker.py`** (it may have changed since v0.5.0). Confirm `_emit`'s current signature and the event-dict construction around line 124-142. Confirm `self.events` is the list serialized into the step result.

- [ ] **Step 2: Write the failing test** — add to `clients/python/tests/test_worker.py` (follow the file's existing style: construct a `StepContext`, call methods, assert on `ctx.events`):

```python
def test_sub_event_emits_run_identity_group_and_phase():
    ctx = StepContext()  # match however existing tests construct it; see other tests in this file
    ctx.sub_event(id="r1", name="ProcessKpi", group="AF_FLEET", phase="processing")
    ctx.sub_event(id="r1", name="ProcessKpi", group="AF_FLEET", status="ok", data={"durationMs": 42})
    assert ctx.events[0]["subId"] == "r1"
    assert ctx.events[0]["name"] == "ProcessKpi"
    assert ctx.events[0]["group"] == "AF_FLEET"
    assert ctx.events[0]["phase"] == "processing"
    assert "status" not in ctx.events[0]
    assert ctx.events[1]["subId"] == "r1"
    assert ctx.events[1]["status"] == "ok"
    assert ctx.events[1]["data"] == {"durationMs": 42}
    assert "phase" not in ctx.events[1]
```

- [ ] **Step 3: Run it, see it fail** — `cd clients/python && python -m pytest tests/test_worker.py -k sub_event -q` (or the repo's configured runner — check `clients/python/pyproject.toml` for the test command). Expected: FAIL — `StepContext` has no `sub_event`.

- [ ] **Step 4: Implement.** In `worker.py`:
  - Extend `_emit` to accept `sub_id=None`, `group=None`, `phase=None` and add them to the event dict only when not `None`, using the camelCase keys `subId`/`group`/`phase` (mirror how `name`/`status`/`process` are conditionally added).
  - Add `StepContext.sub_event`:
```python
    def sub_event(
        self,
        *,
        id: str,
        name: str,
        group: Optional[str] = None,
        phase: Optional[str] = None,
        status: Optional[str] = None,
        message: Optional[str] = None,
        data: Any = None,
    ) -> None:
        level = "error" if status == "failed" else "warn" if status == "skipped" else "info"
        self._emit(
            level,
            message or phase or name,
            name=name,
            status=status,
            data=data,
            sub_id=id,
            group=group,
            phase=phase,
        )
```
  - Add a module-level `sub_event(**kwargs)` that delegates to the current step's context (mirror the existing module-level `sub`).

- [ ] **Step 5: Run the test, see it pass.** Same command as Step 3 without `-k` filter to run the file.

- [ ] **Step 6: Export + commit.** Add `sub_event` to `worker.py`'s imports in `__init__.py` and to `__all__`. Run the SDK's full test suite + any typecheck/lint it has (`pyproject.toml`). Commit `worker.py`, `__init__.py`, the test (explicit paths).

### Task A2: Changeset + release

- [ ] **Step 1:** Add a changeset for the Python SDK package (find its package name/path — the Python SDK may version via `__version__` + a JS changeset wrapper or its own scheme; check how prior SDK releases were cut, e.g. `git log -- clients/python`). Follow the repo's established Python-release mechanism rather than inventing one.
- [ ] **Step 2:** Push on a branch, open PR (do not publish by hand — CI/changesets release on merge, per repo convention). Coordinate the merge with the concurrent Python work.

---

## Component B — flip-python-db: emit run-id + group + phases

`PProcess.run()` (`app/common/interface/p_process.py`) already: mints `process_run_id = str(uuid.uuid4())` (line ~20), receives `handler_name`, emits v1 SQS lifecycle (TRIGGERED/VALIDATING/PROCESSING/NOT_VALID/COMPLETED/ERROR), and already calls the durable sink `set_current_process(name)` (line ~40) + `emit_subprocess(name, status, msg, {"durationMs": …})` (lines ~102/143/170). The durable worker imports these as `from durable_worker import set_process as set_current_process, sub as emit_subprocess` (`app/durable_processing_worker.py` lines 10-12).

**Goal:** route the EXISTING `process_run_id` + `handler_name` + phase transitions into the durable sink via the new `sub_event` API, so the dashboard groups by run id and shows the lifecycle. **Requires Component A released and installed** (bump the `durable_worker` dependency in `flip-python-db`).

**Files:**
- Modify: `app/durable_processing_worker.py` (import `sub_event`)
- Modify: `app/common/interface/p_process.py` (emit phases + terminal via `sub_event`, keyed by `process_run_id`, grouped by `handler_name`)
- Modify: `app/common/durable_proc_events.py` (extend the sink shim + `EventSink` Protocol to expose `sub_event` and a run-id-aware `set_current_process`)
- Test: `tests/test_observable.py` / a new `tests/test_durable_proc_events.py`

### Task B1: Extend the durable sink shim to forward `sub_event` + run-id tagging

`app/common/durable_proc_events.py` currently exposes `emit_subprocess`, `emit_log`, `set_current_process(name)` over a context-local `EventSink`. Add:
- [ ] `emit_subphase(id, name, phase, *, group=None, data=None)` and an `emit_subprocess` variant that takes `id`/`group` (or add params to the existing one), forwarding to the sink's `sub_event`.
- [ ] Update the `EventSink` Protocol to include `sub_event(**kwargs)`.
- [ ] `set_current_process` should tag subsequent logs with the run id (the dashboard groups logs by `subId`); thread the `process_run_id` through, not just the name. Verify what the SDK's log-tagging hook keys on after Component A (it may key logs by `subId` now) and align.
- [ ] Tests: a fake sink capturing calls; assert `emit_subphase`/terminal forward the right `id`/`group`/`phase`/`status`. No-op when no sink installed (outside a durable run) — keep the existing "cheap no-op" guard.

### Task B2: Emit phases + terminal from `PProcess.run()`

- [ ] At each lifecycle point in `PProcess.run()` that already sends the v1 SQS message, ALSO emit the durable phase via the sink: `triggered` → `validating` → (`not_valid` terminal `skipped` | `processing` → `completed` terminal `ok`) | `error` terminal `failed`. Use `process_run_id` as `id`, class name as `name`, `handler_name` as `group`, and keep the existing `{"durationMs": …}` on the terminal.
- [ ] Replace the current name-only `set_current_process(self.__class__.__name__)` with the run-id-aware call so logs tag to this run.
- [ ] Tests (`tests/test_observable.py` style — mock the sink, drive a fake PProcess through validate→process→complete and through the failure path; assert the sub_event sequence has the right phases, run id, group, and terminal status). Cover: success path, validation-failure (`skipped`), exception (`failed`).

### Task B3: Bump the `durable_worker` SDK dependency

- [ ] Bump `flip-python-db`'s `durable_worker` dependency to the version released in Component A (check `pyproject.toml`/lock). Run the durable worker tests.

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
