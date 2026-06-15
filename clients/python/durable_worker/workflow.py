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
import traceback
from typing import Any, Callable, Dict, List, Optional


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
    ) -> None:
        self.run_id = run_id
        self._history: Dict[int, Dict[str, Any]] = {e["seq"]: e for e in history}
        self._signals_by_seq: Dict[int, Dict[str, Any]] = {
            s["seq"]: s for s in (pending_signals or [])
        }
        self._seq = 0
        self.commands: List[Dict[str, Any]] = []

    # -- internals -----------------------------------------------------------
    def _next(self) -> int:
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
        (``now``/``uuid``/a write) happen exactly once and replay returns the captured value."""
        seq = self._next()
        found, output = self._replay(seq, "step", name)
        if found:
            return output
        try:
            result = body()
        except Exception as err:  # noqa: BLE001 — recorded as a failed step, then re-raised
            self.commands.append(
                {"kind": "recordStep", "seq": seq, "name": name, "error": _to_error(err)}
            )
            raise StepFailed(_to_error(err)) from err
        self.commands.append({"kind": "recordStep", "seq": seq, "name": name, "output": result})
        return result

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

    def __init__(self, group: str = "workflows") -> None:
        self.group = group
        self._workflows: Dict[str, WorkflowFn] = {}

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

    def process_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Replay one turn of ``task``'s workflow and return the wire-format decision."""
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
            task.get("runId"), task.get("history", []), task.get("pendingSignals")
        )
        try:
            output = _invoke_workflow(fn, ctx, task.get("input"))
            return {**base, "status": "completed", "commands": ctx.commands, "output": output}
        except _Suspend:
            return {**base, "status": "continue", "commands": ctx.commands}
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
