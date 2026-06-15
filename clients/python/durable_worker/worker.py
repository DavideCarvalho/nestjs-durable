"""Core worker: a name->handler registry and the pure task->result dispatch.

Transport (Redis/BullMQ/NATS) is intentionally separate — `process_task` is a pure function of
the task, so it is fully testable without any broker. A transport adapter just feeds tasks in
and ships results out.
"""

from __future__ import annotations

import asyncio
import contextvars
import inspect
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Union

Handler = Callable[..., Union[Any, Awaitable[Any]]]

# The step a handler is currently running, bound for the duration of the call (in the loop for an
# async handler, in the executor thread for a blocking one). Lets code DEEP inside a handler — that
# never received `ctx` — record events via the module-level helpers below, without threading the
# context through every call. Outside a step it's None and the helpers are no-ops.
_current_step: "contextvars.ContextVar[Optional[StepContext]]" = contextvars.ContextVar(
    "durable_current_step", default=None
)


def current_step() -> "Optional[StepContext]":
    """The :class:`StepContext` of the step running on this task/thread, or None outside a step."""
    return _current_step.get()


def log(level: str, message: str, data: Any = None) -> None:
    """Record a log line on the current step (level: debug/info/warn/error). No-op outside a step."""
    ctx = _current_step.get()
    if ctx is not None:
        getattr(ctx, level, ctx.info)(message, data)


def sub(name: str, status: str, message: Optional[str] = None, data: Any = None) -> None:
    """Record a sub-process outcome (ok/failed/skipped) on the current step. No-op outside a step."""
    ctx = _current_step.get()
    if ctx is not None:
        ctx.sub(name, status, message, data)


def set_process(name: Optional[str]) -> None:
    """Tag the current step's subsequent log lines with sub-process ``name`` (None clears). No-op
    outside a step — so the same business code runs on a non-durable path untouched."""
    ctx = _current_step.get()
    if ctx is not None:
        ctx.process(name)


class FatalError(Exception):
    """Raise inside a handler to signal a non-retryable failure (mirrors the TS ``FatalError``).

    The engine will not retry the step regardless of its ``retries`` setting.
    """

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class StepContext:
    """Lets a handler record what happened inside a step — debug/info/warn/error lines and
    per-sub-process outcomes. The events ride back on the result as ``events`` and the engine
    checkpoints them, so the dashboard shows them under the step. The TypeScript counterpart is
    the ``StepLogger`` handed to ``ctx.step`` — same ``StepEvent`` shape, so observability is
    symmetric regardless of which language ran the step.

    A handler opts in by declaring a second parameter::

        @worker.step("processing")
        def run(data, ctx):
            for proc in data["procs"]:
                ok = run_proc(proc)
                ctx.sub(proc["name"], "ok" if ok else "failed")
            return {"context": {...}}
    """

    def __init__(
        self,
        run_id: Optional[str] = None,
        is_cancelled: Optional[Callable[[str], bool]] = None,
        seq: Optional[int] = None,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.events: List[Dict[str, Any]] = []
        self._run_id = run_id
        self._is_cancelled = is_cancelled
        # Step seq + a sink for live progress: when a transport supplies ``on_event``, every event is
        # ALSO handed to it as it happens (e.g. published on the control plane as a ``step.progress``),
        # so a dashboard tails a long step line-by-line instead of waiting for the final result.
        self._seq = seq
        self._on_event = on_event
        # The sub-process a handler is currently inside (set via ``process``), stamped onto log lines
        # so the dashboard groups a fan-out step's trail per sub-process.
        self._process: Optional[str] = None

    def process(self, name: Optional[str]) -> None:
        """Mark the sub-process whose work is now running; subsequent log lines are tagged with it
        (until changed or cleared with ``None``). A no-op for ``sub()`` outcome rows, which name
        themselves. Lets a fan-out handler attribute its log trail to each sub-process."""
        self._process = name

    @property
    def cancelled(self) -> bool:
        """True once the run has been cancelled (a runner subscribed to the control channel marks
        it). Check this at safe points in a long handler and return/raise to bail out early."""
        return bool(
            self._is_cancelled is not None
            and self._run_id is not None
            and self._is_cancelled(self._run_id)
        )

    def raise_if_cancelled(self) -> None:
        """Raise :class:`Cancelled` if the run has been cancelled — a one-liner abort for handlers."""
        if self.cancelled:
            from .cancellation import Cancelled

            raise Cancelled(self._run_id or "")

    def _emit(
        self,
        level: str,
        message: str,
        name: Optional[str] = None,
        status: Optional[str] = None,
        data: Any = None,
    ) -> None:
        event: Dict[str, Any] = {"at": int(time.time() * 1000), "level": level, "message": message}
        if name is not None:
            event["name"] = name
        if status is not None:
            event["status"] = status
        # Tag a log line (no outcome status) with the sub-process it was emitted inside, if any.
        elif self._process is not None:
            event["process"] = self._process
        if data is not None:
            event["data"] = data
        self.events.append(event)
        # Live progress: hand the event to the transport's sink so it streams now (best-effort — a
        # broken sink must never fail the handler; the event is already captured for the result).
        if self._on_event is not None:
            try:
                self._on_event(event)
            except Exception:  # noqa: BLE001 — live-tail is best-effort observability
                pass

    def debug(self, message: str, data: Any = None) -> None:
        self._emit("debug", message, data=data)

    def info(self, message: str, data: Any = None) -> None:
        self._emit("info", message, data=data)

    def warn(self, message: str, data: Any = None) -> None:
        self._emit("warn", message, data=data)

    def error(self, message: str, data: Any = None) -> None:
        self._emit("error", message, data=data)

    def sub(
        self, name: str, status: str, message: Optional[str] = None, data: Any = None
    ) -> None:
        """Record a sub-step / sub-process outcome (e.g. one of N parallel p-processes)."""
        level = "error" if status == "failed" else "warn" if status == "skipped" else "info"
        self._emit(level, message or name, name=name, status=status, data=data)


class Worker:
    """Registers step handlers by name and turns a dispatched task into a result.

    Example::

        worker = Worker(group="payments")

        @worker.step("payments.charge-card")
        async def charge(data):
            res = await stripe.charge(data["orderId"], data["amountCents"])
            return {"chargeId": res.id}
    """

    def __init__(self, group: str = "default") -> None:
        self.group = group
        self._handlers: Dict[str, Handler] = {}
        self._blocking: Dict[str, bool] = {}

    def step(self, name: str, *, blocking: bool = False) -> Callable[[Handler], Handler]:
        """Decorator registering ``fn`` as the handler for step ``name``.

        Set ``blocking=True`` for a synchronous handler that does CPU/DB work: the worker runs it in
        a thread so the event loop stays free to renew the broker's job lock (otherwise a long step
        looks stalled and gets redelivered). The step context is bound inside that thread too, so the
        module-level :func:`log`/:func:`sub`/:func:`set_process` work from anywhere in the call.
        """

        def register(fn: Handler) -> Handler:
            self._handlers[name] = fn
            self._blocking[name] = blocking
            return fn

        return register

    def handles(self, name: str) -> bool:
        return name in self._handlers

    def run(self, *, redis: str = "redis://localhost:6379", prefix: str = "durable") -> None:
        """Run this worker against the Redis/BullMQ transport until the process is signalled, then
        close gracefully. Owns the whole long-running bootstrap a worker process needs — the event
        loop, SIGTERM/SIGINT handling, and the broker connection — so the entrypoint is one call::

            worker = Worker(group="processing")

            @worker.step("processing", blocking=True)
            def handle(data, ctx): ...

            worker.run(redis=redis_url_from_env())

        Blocks until a shutdown signal closes the worker (which finishes the active job and releases
        its lock). For finer control (your own loop/signals), use :func:`run_redis_worker` directly.
        """
        import signal as _signal

        from .redis_runner import run_redis_worker

        async def _main() -> None:
            bull_worker = await run_redis_worker(
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
                    pass  # no signal support here (e.g. not the main thread) — rely on redelivery
            await stop.wait()

        asyncio.run(_main())

    def process_task(
        self,
        task: Dict[str, Any],
        is_cancelled: Optional[Callable[[str], bool]] = None,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """Run the handler for ``task`` and return a wire-format result.

        Pure and synchronous from the caller's view (async handlers are awaited internally), so a
        transport can simply ``result = worker.process_task(task); send(result)``. Pass
        ``is_cancelled`` so the handler's ``ctx.cancelled`` reflects cooperative cancellation, and
        ``on_event`` to receive each step event live (for ``step.progress`` streaming).
        """

        base = self._base(task)
        handler = self._handlers.get(task["name"])
        if handler is None:
            return self._no_handler(base, task["name"])
        ctx = self._ctx(task, is_cancelled, on_event)
        try:
            output = _run_bound(handler, task.get("input"), ctx)
            if inspect.isawaitable(output):
                output = asyncio.run(output)
            return self._completed(base, output, ctx)
        except Exception as err:  # noqa: BLE001
            return self._failure(base, err, ctx)

    async def aprocess_task(
        self,
        task: Dict[str, Any],
        is_cancelled: Optional[Callable[[str], bool]] = None,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """Async variant — awaits async handlers in the current loop. Use from a transport that
        already runs inside an event loop (e.g. the BullMQ runner). A handler registered
        ``blocking=True`` runs in a thread so the loop stays free to renew the job lock."""

        base = self._base(task)
        handler = self._handlers.get(task["name"])
        if handler is None:
            return self._no_handler(base, task["name"])
        ctx = self._ctx(task, is_cancelled, on_event)
        try:
            if self._blocking.get(task["name"]):
                loop = asyncio.get_running_loop()
                output = await loop.run_in_executor(
                    None, _run_bound, handler, task.get("input"), ctx
                )
            else:
                output = _run_bound(handler, task.get("input"), ctx)
                if inspect.isawaitable(output):
                    # The context var was reset by _run_bound after the sync part returned the
                    # coroutine; re-bind it for the duration of the await so deep `log()` calls work.
                    token = _current_step.set(ctx)
                    try:
                        output = await output
                    finally:
                        _current_step.reset(token)
            return self._completed(base, output, ctx)
        except Exception as err:  # noqa: BLE001
            return self._failure(base, err, ctx)

    @staticmethod
    def _ctx(
        task: Dict[str, Any],
        is_cancelled: Optional[Callable[[str], bool]],
        on_event: Optional[Callable[[Dict[str, Any]], None]],
    ) -> StepContext:
        return StepContext(
            run_id=task.get("runId"),
            is_cancelled=is_cancelled,
            seq=task.get("seq"),
            on_event=on_event,
        )

    @staticmethod
    def _base(task: Dict[str, Any]) -> Dict[str, Any]:
        # Stamp the worker's pickup time so the engine can report queue-wait (startedAt − enqueuedAt),
        # mirroring the TypeScript ``runStepHandler``. Epoch ms keeps it language-neutral on the wire.
        return {
            "runId": task["runId"],
            "seq": task["seq"],
            "stepId": task["stepId"],
            "startedAt": int(time.time() * 1000),
        }

    @staticmethod
    def _completed(base: Dict[str, Any], output: Any, ctx: StepContext) -> Dict[str, Any]:
        return _with_events({**base, "status": "completed", "output": output}, ctx)

    @staticmethod
    def _no_handler(base: Dict[str, Any], name: str) -> Dict[str, Any]:
        return {
            **base,
            "status": "failed",
            "error": {"message": f"no handler for {name}", "retryable": False},
        }

    @staticmethod
    def _failure(base: Dict[str, Any], err: Exception, ctx: StepContext) -> Dict[str, Any]:
        # Keep whatever the handler logged before it threw — a partial p-process run is exactly
        # the case where the sub-process outcomes matter most.
        if isinstance(err, FatalError):
            error = {"message": str(err), "code": err.code, "retryable": False}
        else:
            error = {"message": str(err)}
        return _with_events({**base, "status": "failed", "error": error}, ctx)


def _run_bound(handler: Handler, input_: Any, ctx: "StepContext") -> Any:
    """Call ``handler`` with ``ctx`` bound as the current step for the duration of the call, so the
    module-level :func:`log`/:func:`sub`/:func:`set_process` reach it from deep in the call tree.
    Passes ``ctx`` as a second arg only if the handler declares one (plain ``def h(data)`` still
    works). Also the target run in the executor thread for a ``blocking=True`` handler."""
    token = _current_step.set(ctx)
    try:
        return handler(input_, ctx) if _wants_ctx(handler) else handler(input_)
    finally:
        _current_step.reset(token)


def _wants_ctx(handler: Handler) -> bool:
    """True if ``handler`` can accept the step context as a second positional argument."""
    try:
        params = list(inspect.signature(handler).parameters.values())
    except (ValueError, TypeError):  # builtins / C functions without a signature
        return False
    positional = [
        p
        for p in params
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    has_var_positional = any(p.kind is inspect.Parameter.VAR_POSITIONAL for p in params)
    return len(positional) >= 2 or has_var_positional


def _with_events(result: Dict[str, Any], ctx: StepContext) -> Dict[str, Any]:
    if ctx.events:
        result["events"] = ctx.events
    return result
