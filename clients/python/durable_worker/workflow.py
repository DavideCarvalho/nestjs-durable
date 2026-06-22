"""Author durable workflows in Python — coordinator-driven.

The engine (nestjs) stays the sole owner of the durable state, recovery and timers. It advances a run
one TURN at a time by sending a workflow task (the run's history) here; this runtime REPLAYS the
workflow function locally and returns the commands the function produced, which the engine persists
and dispatches. The runtime never touches a store.

    workflows = WorkflowWorker(group="py-workflows")

    @workflows.workflow("pipeline")
    def pipeline(ctx, base_id):
        key = ctx.step("setup", lambda: f"/{base_id}/data.csv")     # local step: run once, replayed
        rows = ctx.call("ingestion", {"key": key}, group="pipeline")  # remote step: dispatched + awaited
        ctx.sleep(60_000)                                             # durable timer
        return {"rows": rows}

Each `ctx.*` op is keyed by a deterministic seq. On replay an op already in history returns its
recorded result; the first UNRESOLVED blocking op (call/sleep/wait_signal/start_child) suspends the
turn, emitting its command. Local steps run inline and record their result (so side effects /
non-determinism happen once). See docs/plans/2026-06-15-polyglot-workflows-protocol.md.
"""

from __future__ import annotations

import inspect
import threading
import time
import traceback
from typing import Any, Callable, Dict, List, Optional

from .cancellation import Cancelled


class WorkflowError(Exception):
    """Base for workflow-runtime errors."""


class NondeterminismError(WorkflowError):
    """The history doesn't match what the replay produced at a seq — the workflow code changed under
    a run that is already in flight. The run fails loudly rather than silently diverging."""


class StepFailed(Exception):
    """A step/call/child the workflow awaited resolved to a failure. Catchable in workflow code
    (``try/except``) exactly like an awaited rejection — catch it to compensate, or let it propagate
    to fail the run."""

    def __init__(self, error: Optional[Dict[str, Any]]) -> None:
        self.error: Dict[str, Any] = error or {"message": "step failed"}
        super().__init__(self.error.get("message", "step failed"))


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


class _Suspend(Exception):
    """Internal: stop the replay at the first unresolved blocking op."""


def _to_error(err: Exception) -> Dict[str, Any]:
    out: Dict[str, Any] = {"message": str(err) or err.__class__.__name__}
    code = getattr(err, "code", None)
    if code:
        out["code"] = code
    out["stack"] = traceback.format_exc()
    return out


class WorkflowContext:
    """The replay context handed to a workflow function. Its ops are deterministic: same code + same
    history ⇒ same seqs ⇒ same decisions."""

    def __init__(
        self,
        run_id: Optional[str],
        history: List[Dict[str, Any]],
        pending_signals: Optional[List[Dict[str, Any]]] = None,
        on_step: Optional[Callable[[Dict[str, Any]], None]] = None,
        is_cancelled: Optional[Callable[[str], bool]] = None,
    ) -> None:
        self.run_id = run_id
        self._history: Dict[int, Dict[str, Any]] = {e["seq"]: e for e in history}
        self._signals_by_seq: Dict[int, Dict[str, Any]] = {
            s["seq"]: s for s in (pending_signals or [])
        }
        self._seq = 0
        self.commands: List[Dict[str, Any]] = []
        # Optional sink that streams each local step's lifecycle (running → completed/failed) to the
        # engine AS IT HAPPENS, so a long inline turn's steps show up live instead of all at the end.
        self._on_step = on_step
        # Cooperative cancellation source (the runner subscribes to the control channel and feeds it).
        # The replay bails at the next op boundary when this reports the run cancelled — see `_next`.
        self._is_cancelled = is_cancelled

    def _emit_step(self, event: Dict[str, Any]) -> None:
        """Best-effort: stream a step lifecycle event. A broken sink must never fail the workflow."""
        if self._on_step is None:
            return
        try:
            self._on_step(event)
        except Exception:  # noqa: BLE001 — live-tail is best-effort observability
            pass

    # -- internals -----------------------------------------------------------
    def _raise_if_cancelled(self) -> None:
        """Abort the turn at the next op boundary when the run has been cancelled (control-channel
        broadcast → registry). Gives AUTOMATIC between-step cancellation: a workflow body stops
        between ops with no ``if ctx.cancelled`` checks in user code. Mid-step cancellation (inside one
        long ``ctx.step`` body) stays cooperative — check ``current_step().cancelled`` there."""
        if (
            self._is_cancelled is not None
            and self.run_id is not None
            and self._is_cancelled(self.run_id)
        ):
            raise Cancelled(self.run_id)

    def _next(self) -> int:
        # Every durable op (step/call/sleep/wait_signal/start_child) takes its seq from here, so this is
        # the single choke point where between-op cancellation is enforced for the whole workflow API.
        self._raise_if_cancelled()
        seq = self._seq
        self._seq += 1
        return seq

    def _replay(self, seq: int, kind: str, name: Optional[str] = None):
        """(found, output) for a resolved op in history; raises on mismatch or recorded failure."""
        ev = self._history.get(seq)
        if ev is None:
            return False, None
        if ev.get("kind") != kind or (name is not None and ev.get("name") not in (None, name)):
            raise NondeterminismError(
                f"history at seq {seq} is {ev.get('kind')}/{ev.get('name')!r}, "
                f"but replay reached {kind}/{name!r}"
            )
        if ev.get("error") is not None:
            raise StepFailed(ev["error"])
        return True, ev.get("output")

    # -- the workflow API ----------------------------------------------------
    def call(self, name: str, input: Any = None, *, group: str) -> Any:
        """Dispatch a remote step (any-language worker in ``group``) and await its result."""
        seq = self._next()
        found, output = self._replay(seq, "call", name)
        if found:
            return output
        self.commands.append(
            {"kind": "call", "seq": seq, "name": name, "group": group, "input": input}
        )
        raise _Suspend()

    def step(self, name: str, body: Callable[[], Any]) -> Any:
        """Run a LOCAL step once and record its result, so side effects / non-determinism
        (``now``/``uuid``/a write) happen exactly once and replay returns the captured value.

        While the body runs it is the *current step*, so ``sub_process``/``sub_event``/``log`` inside
        a handler are captured as the step's ``events`` (the dashboard shows each handler's p-processes
        under it). The step's real wall-clock window is recorded too (a true duration, not 0ms), and
        its lifecycle (running → completed/failed) is streamed live via ``_emit_step``."""
        from .worker import StepContext, _current_step  # lazy: avoid an import cycle with worker.py

        seq = self._next()
        found, output = self._replay(seq, "step", name)
        if found:
            return output

        started_ms = int(time.time() * 1000)
        self._emit_step(
            {"runId": self.run_id, "seq": seq, "name": name, "phase": "running", "startedAt": started_ms}
        )
        step_ctx = StepContext(
            run_id=self.run_id, seq=seq, is_cancelled=self._is_cancelled
        )
        token = _current_step.set(step_ctx)
        try:
            result = body()
        except Exception as err:  # noqa: BLE001 — recorded as a failed step, then re-raised
            error = _to_error(err)
            finished_ms = int(time.time() * 1000)
            cmd: Dict[str, Any] = {
                "kind": "recordStep",
                "seq": seq,
                "name": name,
                "error": error,
                "startedAt": started_ms,
                "finishedAt": finished_ms,
            }
            if step_ctx.events:
                cmd["events"] = step_ctx.events
            self.commands.append(cmd)
            self._emit_step(
                {
                    "runId": self.run_id,
                    "seq": seq,
                    "name": name,
                    "phase": "failed",
                    "startedAt": started_ms,
                    "finishedAt": finished_ms,
                    "error": error,
                    "events": step_ctx.events,
                }
            )
            raise StepFailed(error) from err
        finally:
            _current_step.reset(token)

        finished_ms = int(time.time() * 1000)
        cmd = {
            "kind": "recordStep",
            "seq": seq,
            "name": name,
            "output": result,
            "startedAt": started_ms,
            "finishedAt": finished_ms,
        }
        if step_ctx.events:
            cmd["events"] = step_ctx.events
        self.commands.append(cmd)
        self._emit_step(
            {
                "runId": self.run_id,
                "seq": seq,
                "name": name,
                "phase": "completed",
                "startedAt": started_ms,
                "finishedAt": finished_ms,
                "output": result,
                "events": step_ctx.events,
            }
        )
        return result

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

    def sleep(self, ms: int) -> None:
        """Durably sleep ``ms``; the run suspends and the engine resumes it when the timer fires."""
        seq = self._next()
        found, _ = self._replay(seq, "timer")
        if found:
            return
        self.commands.append({"kind": "sleep", "seq": seq, "ms": ms})
        raise _Suspend()

    def wait_signal(self, name: str) -> Any:
        """Block until a signal ``name`` is delivered to this run; returns its payload."""
        seq = self._next()
        found, output = self._replay(seq, "signal", name)
        if found:
            return output
        sig = self._signals_by_seq.get(seq)
        if sig is not None:
            return sig.get("payload")
        self.commands.append({"kind": "waitSignal", "seq": seq, "signal": name})
        raise _Suspend()

    def start_child(self, workflow: str, input: Any = None) -> Any:
        """Start a child run and await its output (its own durable lifecycle)."""
        seq = self._next()
        found, output = self._replay(seq, "child", workflow)
        if found:
            return output
        self.commands.append(
            {"kind": "startChild", "seq": seq, "workflow": workflow, "input": input}
        )
        raise _Suspend()


WorkflowFn = Callable[..., Any]


class WorkflowWorker:
    """Registers workflow functions by name and turns a workflow task into a decision. Pure and
    transport-free (``process_task`` is a function of the task), so it's testable without a broker."""

    def __init__(self, group: str = "workflows", *, auto_register: bool = True) -> None:
        self.group = group
        self._workflows: Dict[str, WorkflowFn] = {}
        # Auto-register into the module-level registry so :func:`~durable_worker.worker.run_all` can
        # discover this worker. Opt out with ``auto_register=False``. Importing from ``.worker`` here
        # is safe: ``worker.py`` imports ``workflow.py`` only inside functions, so there's no cycle.
        if auto_register:
            from .worker import register_worker

            register_worker(self)

    def workflow(self, name: str) -> Callable[[WorkflowFn], WorkflowFn]:
        """Decorator registering ``fn`` as the workflow ``name``. ``fn(ctx, input)`` (or ``fn(ctx)``)."""

        def register(fn: WorkflowFn) -> WorkflowFn:
            self._workflows[name] = fn
            return fn

        return register

    def handles(self, name: str) -> bool:
        return name in self._workflows

    def run(self, *, redis: str = "redis://localhost:6379", prefix: str = "durable") -> None:
        """Run this workflow worker against the Redis/BullMQ transport until signalled, then close.
        Owns the loop, SIGTERM graceful close and broker connection — the entrypoint is one call::

            workflows = WorkflowWorker(group="py-workflows")

            @workflows.workflow("pipeline")
            def pipeline(ctx, input): ...

            workflows.run(redis=redis_url_from_env())
        """
        import asyncio
        import signal as _signal

        from .redis_runner import run_redis_workflow_worker

        async def _main() -> None:
            bull_worker = await run_redis_workflow_worker(
                self, group=self.group, connection=redis, prefix=prefix
            )
            stop = asyncio.Event()
            loop = asyncio.get_running_loop()

            async def _graceful() -> None:
                try:
                    await bull_worker.close()
                finally:
                    stop.set()

            for sig in (_signal.SIGTERM, _signal.SIGINT):
                try:
                    loop.add_signal_handler(sig, lambda: asyncio.ensure_future(_graceful()))
                except (NotImplementedError, RuntimeError):
                    pass
            await stop.wait()

        asyncio.run(_main())

    def process_task(
        self,
        task: Dict[str, Any],
        on_step: Optional[Callable[[Dict[str, Any]], None]] = None,
        is_cancelled: Optional[Callable[[str], bool]] = None,
    ) -> Dict[str, Any]:
        """Replay one turn of ``task``'s workflow and return the wire-format decision. ``on_step``, when
        given, streams each local step's lifecycle (running → completed/failed) to the engine live.
        ``is_cancelled`` lets the replay bail at an op boundary when the run was cancelled (returns a
        ``cancelled`` decision) and feeds ``ctx.cancelled`` for cooperative mid-step checks."""
        base = {"taskId": task.get("taskId"), "runId": task.get("runId")}
        fn = self._workflows.get(task.get("workflow"))
        if fn is None:
            return {
                **base,
                "status": "failed",
                "commands": [],
                "error": {
                    "message": f"no workflow registered for {task.get('workflow')!r}",
                    "code": "no_workflow",
                },
            }
        ctx = WorkflowContext(
            task.get("runId"),
            task.get("history", []),
            task.get("pendingSignals"),
            on_step=on_step,
            is_cancelled=is_cancelled,
        )
        try:
            output = _invoke_workflow(fn, ctx, task.get("input"))
            return {**base, "status": "completed", "commands": ctx.commands, "output": output}
        except _Suspend:
            return {**base, "status": "continue", "commands": ctx.commands}
        except Cancelled:
            # Cancelled at an op boundary (run cancelled mid-turn). Bail without clobbering: the engine
            # already set status=cancelled. Return the steps that DID run this turn so it can record
            # partial progress / where the run stopped.
            return {**base, "status": "cancelled", "commands": ctx.commands}
        except StepFailed as err:
            return {**base, "status": "failed", "commands": ctx.commands, "error": err.error}
        except Exception as err:  # noqa: BLE001
            return {**base, "status": "failed", "commands": ctx.commands, "error": _to_error(err)}


def _invoke_workflow(fn: WorkflowFn, ctx: WorkflowContext, input_: Any) -> Any:
    """Call the workflow with ``ctx`` and the input (passing input only if it declares a 2nd param)."""
    try:
        params = list(inspect.signature(fn).parameters.values())
        wants_input = len(
            [
                p
                for p in params
                if p.kind
                in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
            ]
        ) >= 2 or any(p.kind is inspect.Parameter.VAR_POSITIONAL for p in params)
    except (ValueError, TypeError):
        wants_input = True
    return fn(ctx, input_) if wants_input else fn(ctx)
