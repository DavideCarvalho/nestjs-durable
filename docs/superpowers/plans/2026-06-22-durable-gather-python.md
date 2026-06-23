# Python `durable-worker` `gather` Primitive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ctx.gather` (N local step bodies in parallel via threads) and `ctx.gather_children` (N child workflows in parallel) to the Python `durable-worker` library, both waiting for all results with `wait_all`/`fail_fast` failure modes.

**Architecture:** `WorkflowContext` keeps the existing command/replay model: every op takes a deterministic `seq` from `_next()`, resolves from `_history` on replay, and emits commands the nestjs engine persists. `gather` reserves a contiguous seq block in list order (the determinism anchor), runs each local step body in its own thread (mirroring the existing `blocking=True` step path), records each outcome as a `recordStep` command in seq order after all join, and raises `GatherFailed` (a `StepFailed` subclass) if any failed. `gather_children` emits N `startChild` commands in one turn then suspends once, resuming until all children resolve.

**Tech Stack:** Python 3.9+ (`>=3.9` per `pyproject.toml`), `threading`, `contextvars`, pytest 9.

## Global Constraints

- **Determinism:** same code + same history ⇒ same seqs ⇒ same decision. `gather`/`gather_children` MUST reserve `len(items)` consecutive seqs via `_next()` in list order before running/dispatching anything. Reordering items or changing their count is a workflow-version change for in-flight runs.
- **Replay never re-runs a recorded item:** on replay, a gather whose seqs are all in `_history` reconstructs its result/raise from history WITHOUT invoking any body (assert this with bodies that raise if called).
- **`wait_all` is the default mode.** `fail_fast` cancellation is **cooperative** (no forced thread kill): it sets a gather-local `threading.Event` that siblings observe via `current_step().cancelled`.
- **`GatherFailed` subclasses `StepFailed`** so `WorkflowWorker.process_task` maps it to `{status: "failed", error: <aggregate>}`.
- **`parallelGroup` is additive wire metadata.** It is an extra key on the `recordStep`/`startChild` command dicts. **Deployment-ordering constraint (out of scope for this plan, but MUST be honoured before the flip `processing` workflow ships `gather` to production):** the nestjs engine's command parser must accept+ignore (or persist) `parallelGroup` BEFORE any Python worker emitting it is deployed, or a strict engine schema will reject the command and break processing. This plan only builds+unit-tests the Python primitive; the engine-side change and rollout sequencing live in the `/durable` viz plan.
- **Files:** all changes are under `clients/python/`. Run tests from that directory.
- **Test command:** `python3 -m pytest <path> -q` (run from `clients/python/`; pytest 9.0.2, python3 = 3.12).

---

## File Structure

- `clients/python/durable_worker/workflow.py` — add `GatherFailed`, `WorkflowContext.gather`, `WorkflowContext.gather_children`. (All workflow ops already live here as `WorkflowContext` methods; `gather` is tightly coupled to `_next`/`_history`/`commands`/`_emit_step`/`_is_cancelled`/`run_id`, so it belongs here, not a new module.)
- `clients/python/durable_worker/__init__.py` — export `GatherFailed`.
- `clients/python/tests/test_workflow_gather.py` — new test file for both primitives.

---

## Task 1: `GatherFailed` exception

**Files:**
- Modify: `clients/python/durable_worker/workflow.py` (add class after `StepFailed`, ~line 50)
- Modify: `clients/python/durable_worker/__init__.py` (export it)
- Test: `clients/python/tests/test_workflow_gather.py` (create)

**Interfaces:**
- Produces: `class GatherFailed(StepFailed)` with attribute `errors: List[Dict[str, Any]]` (each `{"name": str, "error": dict}`) and an aggregate `.error` dict `{"message": str, "errors": [...]}`.

- [ ] **Step 1: Write the failing test**

Create `clients/python/tests/test_workflow_gather.py`:

```python
import unittest

from durable_worker import GatherFailed
from durable_worker.workflow import StepFailed


class GatherFailedTest(unittest.TestCase):
    def test_is_a_stepfailed_with_aggregate_error(self):
        errs = [
            {"name": "handle_MEL", "error": {"message": "boom"}},
            {"name": "handle_MVR", "error": {"message": "nope"}},
        ]
        gf = GatherFailed(errs)
        self.assertIsInstance(gf, StepFailed)
        self.assertEqual(gf.errors, errs)
        self.assertEqual(gf.error["errors"], errs)
        self.assertIn("handle_MEL", gf.error["message"])
        self.assertIn("handle_MVR", gf.error["message"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_workflow_gather.py -q`
Expected: FAIL with `ImportError: cannot import name 'GatherFailed'`

- [ ] **Step 3: Implement `GatherFailed`**

In `clients/python/durable_worker/workflow.py`, immediately after the `StepFailed` class (after line 49), add:

```python
class GatherFailed(StepFailed):
    """One or more items in a ``ctx.gather`` / ``ctx.gather_children`` failed. Carries the per-item
    errors and presents an aggregate ``.error`` so ``process_task`` records the gather as a failed
    decision. Subclasses :class:`StepFailed` so it is catchable in workflow code like any awaited
    failure."""

    def __init__(self, errors: List[Dict[str, Any]]) -> None:
        self.errors: List[Dict[str, Any]] = errors
        names = ", ".join(str(e.get("name")) for e in errors)
        super().__init__(
            {"message": f"gather: {len(errors)} item(s) failed: {names}", "errors": errors}
        )
```

- [ ] **Step 4: Export it**

In `clients/python/durable_worker/__init__.py`, add `GatherFailed` to the `from .workflow import ...` line and to `__all__` (match the existing export style for `StepFailed`/`WorkflowContext`). If `__init__.py` re-exports by an explicit list, append `"GatherFailed"`.

- [ ] **Step 5: Run test to verify it passes**

Run: `python3 -m pytest tests/test_workflow_gather.py -q`
Expected: PASS (1 passed)

- [ ] **Step 6: Commit**

```bash
cd ~/personal/oss/nestjs/nestjs-durable
git add clients/python/durable_worker/workflow.py clients/python/durable_worker/__init__.py clients/python/tests/test_workflow_gather.py
git commit -m "feat(durable-worker): add GatherFailed aggregate error

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `ctx.gather` — parallel local steps (threads)

**Files:**
- Modify: `clients/python/durable_worker/workflow.py` (add `gather` method to `WorkflowContext`, after `step`, ~line 226; add `import threading` to the top imports)
- Test: `clients/python/tests/test_workflow_gather.py` (append)

**Interfaces:**
- Consumes: `GatherFailed` (Task 1); `WorkflowContext` internals `_next()`, `_history`, `commands`, `_emit_step()`, `_is_cancelled`, `run_id`; `StepContext` and `_current_step` from `.worker`.
- Produces: `WorkflowContext.gather(self, items: List[Tuple[str, Callable[[], Any]]], mode: str = "wait_all") -> List[Any]`. `items` is `(name, body)` pairs, `body` a zero-arg callable. Returns results in input order. Raises `GatherFailed` if any item failed. `mode` ∈ `{"wait_all", "fail_fast"}`.

- [ ] **Step 1: Write the failing tests**

Append to `clients/python/tests/test_workflow_gather.py`:

```python
from durable_worker.workflow import WorkflowContext, GatherFailed as _GF  # noqa: E402


class GatherStepsTest(unittest.TestCase):
    def _ctx(self, history=None, is_cancelled=None):
        return WorkflowContext("run1", history or [], is_cancelled=is_cancelled)

    def test_runs_all_and_returns_results_in_input_order(self):
        ctx = self._ctx()
        out = ctx.gather([
            ("a", lambda: 1),
            ("b", lambda: 2),
            ("c", lambda: 3),
        ])
        self.assertEqual(out, [1, 2, 3])
        # Reserves seqs 0,1,2 in list order and records one step command each.
        steps = [c for c in ctx.commands if c["kind"] == "recordStep"]
        self.assertEqual([c["seq"] for c in steps], [0, 1, 2])
        self.assertEqual([c["name"] for c in steps], ["a", "b", "c"])
        # All share one parallelGroup marker.
        groups = {c["parallelGroup"] for c in steps}
        self.assertEqual(len(groups), 1)

    def test_replay_does_not_rerun_bodies(self):
        history = [
            {"seq": 0, "kind": "step", "name": "a", "output": 1},
            {"seq": 1, "kind": "step", "name": "b", "output": 2},
        ]
        ctx = self._ctx(history)

        def boom():
            raise AssertionError("body must not run on replay")

        out = ctx.gather([("a", boom), ("b", boom)])
        self.assertEqual(out, [1, 2])
        self.assertEqual(ctx.commands, [])  # nothing re-recorded

    def test_wait_all_aggregates_failures_and_records_every_outcome(self):
        ctx = self._ctx()

        def fail():
            raise ValueError("boom")

        with self.assertRaises(_GF) as cm:
            ctx.gather([("ok", lambda: 1), ("bad", fail), ("ok2", lambda: 2)])
        names = [e["name"] for e in cm.exception.errors]
        self.assertEqual(names, ["bad"])
        # wait_all still records all three step commands (ok, bad, ok2).
        recorded = [c["name"] for c in ctx.commands if c["kind"] == "recordStep"]
        self.assertEqual(recorded, ["ok", "bad", "ok2"])
        bad = next(c for c in ctx.commands if c["name"] == "bad")
        self.assertIn("error", bad)

    def test_empty_items_returns_empty(self):
        ctx = self._ctx()
        self.assertEqual(ctx.gather([]), [])
        self.assertEqual(ctx.commands, [])

    def test_single_item_behaves_like_one_step(self):
        ctx = self._ctx()
        out = ctx.gather([("only", lambda: 42)])
        self.assertEqual(out, [42])
        steps = [c for c in ctx.commands if c["kind"] == "recordStep"]
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["output"], 42)

    def test_fail_fast_signals_cooperative_cancel_to_siblings(self):
        from durable_worker.worker import current_step
        import threading

        ctx = self._ctx()
        sibling_saw_cancel = threading.Event()
        first_failed = threading.Event()

        def fail():
            first_failed.set()
            raise ValueError("boom")

        def sibling():
            # Wait until the failing item has failed, then observe cooperative cancel.
            first_failed.wait(timeout=2)
            step = current_step()
            for _ in range(200):
                if step is not None and step.cancelled:
                    sibling_saw_cancel.set()
                    return "cancelled"
                threading.Event().wait(0.005)
            return "ran-to-completion"

        with self.assertRaises(_GF):
            ctx.gather([("bad", fail), ("sib", sibling)], mode="fail_fast")
        self.assertTrue(sibling_saw_cancel.is_set())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_workflow_gather.py -q`
Expected: FAIL with `AttributeError: 'WorkflowContext' object has no attribute 'gather'`

- [ ] **Step 3: Add `import threading`**

In `clients/python/durable_worker/workflow.py`, add to the stdlib imports (after `import time`, line 26):

```python
import threading
```

- [ ] **Step 4: Implement `gather`**

In `clients/python/durable_worker/workflow.py`, add this method to `WorkflowContext` immediately after the `step` method (after line 226, before `sleep`):

```python
    def gather(
        self,
        items: "List[tuple]",
        mode: str = "wait_all",
    ) -> "List[Any]":
        """Run N LOCAL step bodies CONCURRENTLY (each in its own thread) and wait for all.

        ``items`` is a list of ``(name, body)`` where ``body`` is a zero-arg callable returning the
        step's result. Reserves a contiguous seq block in list order (the determinism anchor), runs
        every body in a thread, then records each outcome as a ``recordStep`` command in seq order.

        ``mode``:
          ``"wait_all"`` (default) — wait for every item to settle, record all, raise
              :class:`GatherFailed` if any failed.
          ``"fail_fast"`` — on the first failure, set a gather-local cancel flag the still-running
              siblings observe via ``current_step().cancelled`` (cooperative; no thread kill), then
              raise once all threads have joined.

        Returns results in input order. Deterministic: on replay (all seqs already in history) it
        reconstructs the result/raise from history WITHOUT invoking any body.
        """
        from .worker import StepContext, _current_step  # lazy: avoid import cycle with worker.py

        entries = [(self._next(), name, body) for name, body in items]
        if not entries:
            return []
        group = f"gather:{entries[0][0]}"

        # Replay: inline steps all record in ONE turn, so either ALL or NONE of the seqs are present.
        if all(self._history.get(seq) is not None for seq, _, _ in entries):
            outputs: List[Any] = []
            failures: List[Dict[str, Any]] = []
            for seq, name, _ in entries:
                ev = self._history[seq]
                if ev.get("error") is not None:
                    failures.append({"name": name, "error": ev["error"]})
                    outputs.append(None)
                else:
                    outputs.append(ev.get("output"))
            if failures:
                raise GatherFailed(failures)
            return outputs

        cancel = threading.Event()
        run_cancel = self._is_cancelled
        run_id = self.run_id

        def combined_cancel(rid: str) -> bool:
            return cancel.is_set() or bool(run_cancel is not None and run_cancel(rid))

        started = int(time.time() * 1000)
        for seq, name, _ in entries:
            self._emit_step(
                {"runId": run_id, "seq": seq, "name": name, "phase": "running",
                 "startedAt": started, "parallelGroup": group}
            )

        results: Dict[int, Dict[str, Any]] = {}

        def run_one(seq: int, body: Callable[[], Any]) -> None:
            step_ctx = StepContext(run_id=run_id, seq=seq, is_cancelled=combined_cancel)
            token = _current_step.set(step_ctx)
            try:
                output = body()
                results[seq] = {"output": output, "events": step_ctx.events}
            except Exception as err:  # noqa: BLE001 — recorded per item; aggregated after join
                results[seq] = {"error": _to_error(err), "events": step_ctx.events}
                if mode == "fail_fast":
                    cancel.set()
            finally:
                _current_step.reset(token)

        threads = [
            threading.Thread(target=run_one, args=(seq, body), name=f"gather-{seq}")
            for seq, _, body in entries
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        finished = int(time.time() * 1000)
        outputs = []
        failures = []
        for seq, name, _ in entries:
            r = results.get(seq, {"error": {"message": "gather item did not run"}, "events": []})
            cmd: Dict[str, Any] = {
                "kind": "recordStep", "seq": seq, "name": name,
                "startedAt": started, "finishedAt": finished, "parallelGroup": group,
            }
            if "error" in r:
                cmd["error"] = r["error"]
                failures.append({"name": name, "error": r["error"]})
                outputs.append(None)
            else:
                cmd["output"] = r["output"]
                outputs.append(r["output"])
            if r.get("events"):
                cmd["events"] = r["events"]
            self.commands.append(cmd)
            phase = "failed" if "error" in r else "completed"
            event = {
                "runId": run_id, "seq": seq, "name": name, "phase": phase,
                "startedAt": started, "finishedAt": finished, "parallelGroup": group,
                "events": r.get("events", []),
            }
            if "error" in r:
                event["error"] = r["error"]
            else:
                event["output"] = r["output"]
            self._emit_step(event)

        if failures:
            raise GatherFailed(failures)
        return outputs
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_workflow_gather.py -q`
Expected: PASS (all `GatherStepsTest` + `GatherFailedTest` tests pass)

- [ ] **Step 6: Run the full Python suite (no regressions)**

Run: `python3 -m pytest tests/ -q`
Expected: PASS (previously 82 + the new tests; 0 failures)

- [ ] **Step 7: Commit**

```bash
cd ~/personal/oss/nestjs/nestjs-durable
git add clients/python/durable_worker/workflow.py clients/python/tests/test_workflow_gather.py
git commit -m "feat(durable-worker): ctx.gather — parallel local steps (threads)

wait_all (default) + cooperative fail_fast, deterministic seq block,
replay re-derives from history, parallelGroup marker on commands.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `ctx.gather_children` — parallel child workflows

**Files:**
- Modify: `clients/python/durable_worker/workflow.py` (add `gather_children` after `start_child`, ~line 258)
- Test: `clients/python/tests/test_workflow_gather.py` (append)

**Interfaces:**
- Consumes: `GatherFailed` (Task 1); `_next()`, `_history`, `commands`, `_Suspend`.
- Produces: `WorkflowContext.gather_children(self, workflow: str, inputs: List[Any], mode: str = "wait_all") -> List[Any]`. Dispatches one child per input; returns outputs in input order; raises `GatherFailed` if any child failed; raises `_Suspend` while any child is still outstanding.

- [ ] **Step 1: Write the failing tests**

Append to `clients/python/tests/test_workflow_gather.py`:

```python
from durable_worker.workflow import _Suspend  # noqa: E402


class GatherChildrenTest(unittest.TestCase):
    def _ctx(self, history=None):
        return WorkflowContext("run1", history or [])

    def test_first_turn_dispatches_all_children_then_suspends(self):
        ctx = self._ctx()
        with self.assertRaises(_Suspend):
            ctx.gather_children("handle", [{"p": "MEL"}, {"p": "MVR"}, {"p": "UTIL"}])
        spawns = [c for c in ctx.commands if c["kind"] == "startChild"]
        self.assertEqual([c["seq"] for c in spawns], [0, 1, 2])
        self.assertEqual([c["workflow"] for c in spawns], ["handle", "handle", "handle"])
        self.assertEqual([c["input"]["p"] for c in spawns], ["MEL", "MVR", "UTIL"])
        self.assertEqual(len({c["parallelGroup"] for c in spawns}), 1)

    def test_suspends_while_any_child_outstanding(self):
        # seq 0 done, seq 1 still running (absent from history) → re-dispatch missing + suspend.
        history = [{"seq": 0, "kind": "child", "name": "handle", "output": {"r": 1}}]
        ctx = self._ctx(history)
        with self.assertRaises(_Suspend):
            ctx.gather_children("handle", [{"p": "A"}, {"p": "B"}])
        spawns = [c for c in ctx.commands if c["kind"] == "startChild"]
        self.assertEqual([c["seq"] for c in spawns], [1])  # only the outstanding one re-emitted

    def test_returns_all_outputs_in_order_when_all_resolved(self):
        history = [
            {"seq": 0, "kind": "child", "name": "handle", "output": {"r": 1}},
            {"seq": 1, "kind": "child", "name": "handle", "output": {"r": 2}},
        ]
        ctx = self._ctx(history)
        out = ctx.gather_children("handle", [{"p": "A"}, {"p": "B"}])
        self.assertEqual(out, [{"r": 1}, {"r": 2}])
        self.assertEqual(ctx.commands, [])

    def test_wait_all_aggregates_child_failures(self):
        history = [
            {"seq": 0, "kind": "child", "name": "handle", "output": {"r": 1}},
            {"seq": 1, "kind": "child", "name": "handle", "error": {"message": "child boom"}},
        ]
        ctx = self._ctx(history)
        with self.assertRaises(_GF) as cm:
            ctx.gather_children("handle", [{"p": "A"}, {"p": "B"}])
        self.assertEqual(len(cm.exception.errors), 1)
        self.assertEqual(cm.exception.errors[0]["error"]["message"], "child boom")

    def test_fail_fast_raises_on_first_failed_child_seen(self):
        history = [
            {"seq": 0, "kind": "child", "name": "handle", "error": {"message": "boom"}},
        ]
        ctx = self._ctx(history)
        # seq 1 still outstanding, but fail_fast raises immediately on the failed seq 0.
        with self.assertRaises(_GF):
            ctx.gather_children("handle", [{"p": "A"}, {"p": "B"}], mode="fail_fast")

    def test_empty_inputs_returns_empty(self):
        ctx = self._ctx()
        self.assertEqual(ctx.gather_children("handle", []), [])
        self.assertEqual(ctx.commands, [])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_workflow_gather.py::GatherChildrenTest -q`
Expected: FAIL with `AttributeError: 'WorkflowContext' object has no attribute 'gather_children'`

- [ ] **Step 3: Implement `gather_children`**

In `clients/python/durable_worker/workflow.py`, add this method to `WorkflowContext` immediately after the `start_child` method (after line 258):

```python
    def gather_children(
        self,
        workflow: str,
        inputs: "List[Any]",
        mode: str = "wait_all",
    ) -> "List[Any]":
        """Dispatch N child workflows CONCURRENTLY and wait for ALL their outputs.

        Reserves a contiguous seq block; on the first turn it emits a ``startChild`` command for every
        input (so all children dispatch and run in parallel on the worker pool), then suspends. On each
        child completion the parent resumes; once ALL children have resolved it returns their outputs
        in input order (``wait_all``), or raises :class:`GatherFailed` if any failed.

        ``fail_fast`` raises as soon as a failed child is seen on a resume; sibling child runs are NOT
        force-cancelled in v1 (their eventual results are ignored by the failed run).

        Re-emitting ``startChild`` for an already-dispatched-but-incomplete child is intentional and
        idempotent on the engine (a child has no history entry until it settles) — same contract as
        the single ``start_child``.
        """
        seqs = [self._next() for _ in inputs]
        if not seqs:
            return []
        group = f"gather:{seqs[0]}"
        histories = [self._history.get(seq) for seq in seqs]

        # fail_fast: bail the moment any resolved child is a failure.
        if mode == "fail_fast":
            for seq, ev in zip(seqs, histories):
                if ev is not None and ev.get("error") is not None:
                    raise GatherFailed([{"name": workflow, "error": ev["error"]}])

        pending = False
        for seq, inp, ev in zip(seqs, inputs, histories):
            if ev is None:
                self.commands.append(
                    {"kind": "startChild", "seq": seq, "workflow": workflow,
                     "input": inp, "parallelGroup": group}
                )
                pending = True
        if pending:
            raise _Suspend()

        outputs: List[Any] = []
        failures: List[Dict[str, Any]] = []
        for ev in histories:
            if ev.get("error") is not None:
                failures.append({"name": workflow, "error": ev["error"]})
                outputs.append(None)
            else:
                outputs.append(ev.get("output"))
        if failures:
            raise GatherFailed(failures)
        return outputs
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_workflow_gather.py -q`
Expected: PASS (all `GatherChildrenTest` tests pass)

- [ ] **Step 5: Run the full Python suite**

Run: `python3 -m pytest tests/ -q`
Expected: PASS (0 failures)

- [ ] **Step 6: Commit**

```bash
cd ~/personal/oss/nestjs/nestjs-durable
git add clients/python/durable_worker/workflow.py clients/python/tests/test_workflow_gather.py
git commit -m "feat(durable-worker): ctx.gather_children — parallel child workflows

Dispatch-all-then-suspend, resume-until-all-resolved, wait_all aggregate
+ fail_fast raise-on-first-failed-seen, parallelGroup marker.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: End-to-end determinism via `process_task` + docs

**Files:**
- Test: `clients/python/tests/test_workflow_gather.py` (append an integration test through `WorkflowWorker.process_task`)
- Modify: `clients/python/durable_worker/workflow.py` (module docstring: mention `gather`)

**Interfaces:**
- Consumes: `WorkflowWorker` (existing), `gather` (Task 2).

- [ ] **Step 1: Write the failing test**

Append to `clients/python/tests/test_workflow_gather.py`:

```python
from durable_worker.workflow import WorkflowWorker  # noqa: E402


class GatherProcessTaskTest(unittest.TestCase):
    def test_wait_all_failure_becomes_a_failed_decision_with_aggregate(self):
        ww = WorkflowWorker(group="t", auto_register=False)

        @ww.workflow("wf")
        def wf(ctx, _input):
            return ctx.gather([("ok", lambda: 1), ("bad", lambda: (_ for _ in ()).throw(ValueError("x")))])

        decision = ww.process_task({"taskId": "t1", "runId": "r1", "workflow": "wf",
                                    "history": [], "input": None})
        self.assertEqual(decision["status"], "failed")
        self.assertEqual(decision["error"]["errors"][0]["name"], "bad")
        # The two step commands were still recorded on the failed decision.
        recorded = [c["name"] for c in decision["commands"] if c["kind"] == "recordStep"]
        self.assertEqual(recorded, ["ok", "bad"])

    def test_success_replays_deterministically(self):
        ww = WorkflowWorker(group="t", auto_register=False)
        calls = {"n": 0}

        @ww.workflow("wf")
        def wf(ctx, _input):
            def body_a():
                calls["n"] += 1
                return "a"
            return ctx.gather([("a", body_a), ("b", lambda: "b")])

        first = ww.process_task({"taskId": "t1", "runId": "r1", "workflow": "wf",
                                 "history": [], "input": None})
        self.assertEqual(first["status"], "completed")
        self.assertEqual(first["output"], ["a", "b"])
        # Replay from the recorded history must NOT re-run body_a.
        history = [
            {"seq": c["seq"], "kind": "step", "name": c["name"], "output": c.get("output")}
            for c in first["commands"] if c["kind"] == "recordStep"
        ]
        before = calls["n"]
        second = ww.process_task({"taskId": "t1", "runId": "r1", "workflow": "wf",
                                  "history": history, "input": None})
        self.assertEqual(second["status"], "completed")
        self.assertEqual(second["output"], ["a", "b"])
        self.assertEqual(calls["n"], before)  # no re-run on replay
```

- [ ] **Step 2: Run tests to verify they fail or pass**

Run: `python3 -m pytest tests/test_workflow_gather.py::GatherProcessTaskTest -q`
Expected: PASS (these exercise already-implemented behaviour end-to-end; if either FAILS it reveals a gather/process_task integration bug to fix before continuing).

- [ ] **Step 3: Update the module docstring**

In `clients/python/durable_worker/workflow.py`, in the module docstring's op list (around lines 17-20), add a sentence after the local-steps description:

```
``ctx.gather([(name, body), ...])`` runs N local steps CONCURRENTLY (threads) and waits for all;
``ctx.gather_children(workflow, [inputs])`` does the same with child workflows. Both default to
``wait_all`` (raise an aggregate ``GatherFailed`` if any item fails) with an opt-in ``fail_fast``.
```

- [ ] **Step 4: Run the full suite**

Run: `python3 -m pytest tests/ -q`
Expected: PASS (0 failures)

- [ ] **Step 5: Commit**

```bash
cd ~/personal/oss/nestjs/nestjs-durable
git add clients/python/durable_worker/workflow.py clients/python/tests/test_workflow_gather.py
git commit -m "test(durable-worker): gather end-to-end via process_task + docstring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Out of scope (separate plans)

- **flip `processing` adoption** (replace the sequential `for` with `ctx.gather([...7...])`) — gated on the engine accepting `parallelGroup`.
- **nestjs engine + `/durable` viz** — persist `parallelGroup` on the checkpoint, render the parallel fan. This is the deployment gate for shipping `gather` to flip prod.
- **TS `nestjs-durable` parity** (`ctx.all` over children).
- **Track A** — the `durable-worker` settle/recovery bug (child completes all steps but the run stays `running`).

## Self-Review

- **Spec coverage:** `gather` (steps) ✓ Task 2; `gather_children` ✓ Task 3; `wait_all` default + `fail_fast` cooperative cancel ✓ Tasks 2–3; `GatherFailed` aggregate ✓ Task 1; determinism/replay ✓ Tasks 2 & 4; `parallelGroup` marker ✓ Tasks 2–3; deployment-ordering constraint ✓ Global Constraints. Python fire-and-forget intentionally omitted (YAGNI) ✓. Viz / flip adoption / TS parity / Track A fenced to separate plans ✓.
- **Placeholder scan:** every code step shows complete code; no TBD/TODO. The one `__init__.py` edit (Task 1 Step 4) references "match the existing export style" because the file's exact export form must be read at edit time — the implementer adds the literal `GatherFailed` symbol either way.
- **Type consistency:** `gather(items: List[(name, body)], mode) -> List[Any]`; `gather_children(workflow: str, inputs: List[Any], mode) -> List[Any]`; `GatherFailed.errors: List[{"name","error"}]`; command dicts use `kind`/`seq`/`name`/`parallelGroup` consistently across tasks. Consistent.
