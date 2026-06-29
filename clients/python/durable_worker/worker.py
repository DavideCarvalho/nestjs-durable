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
import uuid
from types import TracebackType
from typing import Any, Awaitable, Callable, Dict, List, Optional, Type, Union

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


def current_context() -> "Optional[Dict[str, Any]]":
    """The opaque context carrier (tenant / user / correlation ids) the engine stamped on the task
    running on this task/thread, or None outside a step / when the dispatcher sent none. Mirrors the
    engine's ``context`` provider — the keys are owned by the producer (e.g. ``@dudousxd/nestjs-context``),
    so the worker just re-exposes the dict without inspecting it."""
    ctx = _current_step.get()
    return ctx.context if ctx is not None else None


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


def sub_event(
    *,
    id: str,
    name: str,
    group: Optional[str] = None,
    phase: Optional[str] = None,
    status: Optional[str] = None,
    message: Optional[str] = None,
    data: Any = None,
) -> None:
    """Record a sub-process event on the current step (see :meth:`StepContext.sub_event`). No-op outside a step."""
    ctx = _current_step.get()
    if ctx is not None:
        ctx.sub_event(
            id=id, name=name, group=group, phase=phase, status=status, message=message, data=data
        )


def sub_process(
    name: str, *, group: Optional[str] = None, id: Optional[str] = None
) -> "_SubProcess":
    """Ergonomic sub-process lifecycle as a context manager::

        with sub_process("ProcessKpi", group="AF_FLEET") as sp:
            sp.phase("validating")
            if not valid:
                sp.skip("; ".join(errors))
                return
            sp.phase("processing")
            ...  # work; logs emitted here are tagged to this sub-process's run id

    On a clean exit it records a terminal ``ok`` with the measured ``durationMs``; on an exception it
    records ``failed`` (with the exception message) and re-raises. ``sp.skip(reason)`` records a
    terminal ``skipped``. The run id is generated automatically. Outside a durable step (no current
    step) every emission is a no-op, so the same business code runs unchanged on a non-durable path."""
    return _SubProcess(name, group=group, id=id)


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
        context: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.events: List[Dict[str, Any]] = []
        self._run_id = run_id
        self._is_cancelled = is_cancelled
        # Opaque context carrier (tenant / user / correlation ids) the engine stamped on the task,
        # re-exposed verbatim to the handler (and via the module-level :func:`current_context`). The
        # producer owns the shape; the worker never inspects it. None when the dispatcher sent none.
        self.context = context
        # Step seq + a sink for live progress: when a transport supplies ``on_event``, every event is
        # ALSO handed to it as it happens (e.g. published on the control plane as a ``step.progress``),
        # so a dashboard tails a long step line-by-line instead of waiting for the final result.
        self._seq = seq
        self._on_event = on_event
        # The sub-process a handler is currently inside (set via ``process``), stamped onto log lines
        # so the dashboard groups a fan-out step's trail per sub-process.
        self._process: Optional[str] = None
        # The run identity of the sub-process a handler is currently inside (set by ``sub_process``),
        # stamped onto log lines so the dashboard groups a fan-out step's trail by run id (not just name).
        self._sub_id: Optional[str] = None

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
        sub_id: Optional[str] = None,
        group: Optional[str] = None,
        phase: Optional[str] = None,
    ) -> None:
        event: Dict[str, Any] = {"at": int(time.time() * 1000), "level": level, "message": message}
        if name is not None:
            event["name"] = name
        if status is not None:
            event["status"] = status
        if phase is not None:
            event["phase"] = phase
        if group is not None:
            event["group"] = group
        # Explicit run id (a sub_event) always wins; otherwise tag a LOG line (no status, no phase)
        # with the sub-process it was emitted inside, by run id and/or name, if any.
        is_log = status is None and phase is None
        resolved_sub_id = sub_id if sub_id is not None else (self._sub_id if is_log else None)
        if resolved_sub_id is not None:
            event["subId"] = resolved_sub_id
        if is_log and self._process is not None:
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
        """Record a sub-process event. Pass ``phase`` for an intermediate transition (no terminal
        status), or ``status`` for the terminal outcome. ``id`` is the run identity (distinct per
        invocation); ``group`` is an open grouping label. The TS counterpart is ``StepLogger.subEvent``."""
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


class _SubProcess:
    """The handle yielded by :func:`sub_process`. See that function for usage."""

    def __init__(self, name: str, *, group: Optional[str] = None, id: Optional[str] = None) -> None:
        self._name = name
        self._group = group
        self._id = id if id is not None else uuid.uuid4().hex
        self._ctx: Optional[StepContext] = None
        self._start = 0.0
        self._terminal = False
        self._prev_process: Optional[str] = None
        self._prev_sub_id: Optional[str] = None

    def __enter__(self) -> "_SubProcess":
        self._ctx = _current_step.get()
        self._start = time.monotonic()
        if self._ctx is not None:
            self._prev_process = self._ctx._process
            self._prev_sub_id = self._ctx._sub_id
            self._ctx._process = self._name
            self._ctx._sub_id = self._id
        return self

    def phase(self, phase: str, data: Any = None) -> "_SubProcess":
        """Record an intermediate transition (a consumer-defined phase label)."""
        if self._ctx is not None and not self._terminal:
            self._ctx.sub_event(
                id=self._id, name=self._name, group=self._group, phase=phase, data=data
            )
        return self

    def skip(self, reason: Optional[str] = None, data: Any = None) -> None:
        """Record a terminal ``skipped`` outcome (e.g. validation failed)."""
        self._emit_terminal("skipped", reason, data)

    def fail(self, reason: Optional[str] = None, data: Any = None) -> None:
        """Record a terminal ``failed`` outcome explicitly (the context manager also does this on an
        exception)."""
        self._emit_terminal("failed", reason, data)

    def _with_duration(self, data: Any) -> Dict[str, Any]:
        ms = int((time.monotonic() - self._start) * 1000)
        if isinstance(data, dict):
            return data if "durationMs" in data else {**data, "durationMs": ms}
        return {"durationMs": ms}

    def _emit_terminal(self, status: str, message: Optional[str], data: Any) -> None:
        if self._ctx is None or self._terminal:
            return
        self._terminal = True
        self._ctx.sub_event(
            id=self._id,
            name=self._name,
            group=self._group,
            status=status,
            message=message,
            data=self._with_duration(data),
        )

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> Optional[bool]:
        if self._ctx is not None:
            try:
                if not self._terminal:
                    if exc_type is not None:
                        self._emit_terminal("failed", str(exc) if exc is not None else None, None)
                    else:
                        self._emit_terminal("ok", None, None)
            finally:
                self._ctx._process = self._prev_process
                self._ctx._sub_id = self._prev_sub_id
        return False  # never suppress exceptions


class Worker:
    """A unified durable worker: registers step handlers AND workflows by name on ONE group, and
    turns a dispatched task into a result (step) or a decision (workflow).

    Workflow turns and step tasks ride the SAME queue ``<prefix>-tasks-<group>`` (distinguished on the
    wire by job shape — see :func:`~durable_worker.workflow.is_workflow_task`), so one ``Worker`` on
    one group runs both — no separate ``WorkflowWorker`` / second group required::

        worker = Worker("processing", concurrency="adaptive")

        @worker.workflow("processing")
        def pipeline(ctx, base_id):
            key = ctx.step("setup", lambda: f"/{base_id}/data.csv")
            rows = ctx.call("ingest", {"key": key})   # no group → inherits "processing"
            return {"rows": rows}

        @worker.step("ingest", blocking=True)
        def ingest(data, ctx): ...

        worker.run()                 # or run_workers([worker])

    A pure step-only worker (no ``@worker.workflow``) behaves exactly as before. The advanced split —
    a workflow worker and a step worker on DIFFERENT groups — is still available via the deprecated
    :class:`~durable_worker.workflow.WorkflowWorker` + ``run_workers([wf, steps])``.
    """

    def __init__(
        self,
        group: str = "default",
        *,
        concurrency: "int | str | dict" = 1,
        namespace: str = "default",
        auto_register: bool = True,
    ) -> None:
        self.group = group
        # Logical deployment namespace, segmenting every queue/stream/key this worker touches so the
        # same Redis can host multiple isolated deployments (e.g. per-developer ``dev-alice``) without
        # crosstalk. ``"default"`` (or unset) keeps names BYTE-IDENTICAL to the un-namespaced scheme, so
        # an already-deployed worker is unaffected. Any other value MUST match the namespace of the
        # engine that dispatches to it — see ``_effective_prefix`` for the cross-SDK naming rule.
        self.namespace = namespace
        # How many tasks this worker runs concurrently from its group's queue (BullMQ Worker
        # concurrency). Default 1 (serial). Raise it so a fanned-out batch (e.g. the N remote steps of
        # a ``gather_calls``) runs in parallel. Per process; total parallelism is concurrency × replicas.
        #
        # Beyond a fixed ``int`` this accepts ``'adaptive'`` (the worker self-tunes its limit from a
        # gradient of observed latency, with a cgroup-aware RAM brake) or a config ``dict``
        # (``min``/``max``/``start``/``ramCeilingPct``/``cpuCeilingPct``/``tickMs``). It is passed
        # through verbatim to ``run_redis_worker``, which resolves it; either way the worker publishes
        # a live status (inFlight / RSS / throughput / p95) on its heartbeat. (Default 1 = fixed.)
        self.concurrency = concurrency
        self._handlers: Dict[str, Handler] = {}
        self._blocking: Dict[str, bool] = {}
        # Workflows this worker also holds (unified worker). Empty for a pure step worker. Keyed by
        # workflow name; the runner routes a workflow task here and a step task to ``_handlers``.
        self._workflows: Dict[str, Handler] = {}
        # Auto-register into the module-level registry so :func:`run_all` can discover this worker
        # without the consumer listing it. Opt out with ``auto_register=False`` (one-off/test workers).
        if auto_register:
            register_worker(self)

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

    def workflow(self, name: str) -> Callable[[Handler], Handler]:
        """Decorator registering ``fn`` as the workflow ``name`` on THIS worker (unified worker).

        ``fn(ctx, input)`` (or ``fn(ctx)``) — same authoring surface as
        :meth:`WorkflowWorker.workflow`. The worker's runner replays a workflow turn for this name and
        runs ``@worker.step`` handlers for step tasks, both off the one ``<prefix>-tasks-<group>`` queue."""

        def register(fn: Handler) -> Handler:
            self._workflows[name] = fn
            return fn

        return register

    def handles_workflow(self, name: str) -> bool:
        return name in self._workflows

    @property
    def has_workflows(self) -> bool:
        """True once any ``@worker.workflow`` is registered — the runner then routes workflow tasks
        through the replay path instead of treating every job as a step."""
        return bool(self._workflows)

    def process_workflow_task(
        self,
        task: Dict[str, Any],
        on_step: Optional[Callable[[Dict[str, Any]], None]] = None,
        is_cancelled: Optional[Callable[[str], bool]] = None,
    ) -> Dict[str, Any]:
        """Replay one turn of a workflow task and return its wire-format decision. The worker's own
        :attr:`group` is threaded into the :class:`~durable_worker.workflow.WorkflowContext`, so a step
        ``call`` with no explicit group inherits this worker's group (one group → one worker)."""
        from .workflow import process_workflow_task  # lazy: avoid an import cycle with workflow.py

        return process_workflow_task(
            self._workflows, task, on_step=on_step, is_cancelled=is_cancelled, group=self.group
        )

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
                self,
                group=self.group,
                connection=redis,
                prefix=prefix,
                concurrency=self.concurrency,
                namespace=self.namespace,
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
            context=task.get("context"),
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


# Module-level auto-registry. Every Worker/WorkflowWorker built with ``auto_register=True`` (the
# default) appends itself here, so :func:`run_all` can run every worker the process imported without
# the consumer listing them — the celery-``autodiscover`` style "magic" form.
_REGISTERED_WORKERS: list = []


def register_worker(worker: "Any") -> None:
    """Add ``worker`` to the auto-registry (idempotent on identity)."""
    if not any(existing is worker for existing in _REGISTERED_WORKERS):
        _REGISTERED_WORKERS.append(worker)


def registered_workers() -> list:
    """Return a shallow copy of the registered workers (callers can't mutate the registry)."""
    return list(_REGISTERED_WORKERS)


def clear_registered_workers() -> None:
    """Empty the auto-registry (for tests / re-init)."""
    _REGISTERED_WORKERS.clear()


def run_all(
    *,
    redis: str = "redis://localhost:6379",
    prefix: str = "durable",
    namespace: str = "default",
) -> None:
    """Run **every** auto-registered worker in one process via :func:`run_workers`.

    The celery-``autodiscover`` style "magic" form: the consumer imports the modules that construct
    its :class:`Worker` / :class:`.WorkflowWorker` instances (so they auto-register), then calls
    ``run_all()`` — no list. The explicit :func:`run_workers` stays as the non-magic alternative.

    With no registered workers this returns early (nothing to run) rather than blocking forever on
    an empty stop-wait.
    """
    workers = registered_workers()
    if not workers:
        print("durable_worker.run_all: no workers registered — nothing to run.")
        return
    run_workers(workers, redis=redis, prefix=prefix, namespace=namespace)


def run_workers(
    workers: "Any",
    *,
    redis: str = "redis://localhost:6379",
    prefix: str = "durable",
    namespace: str = "default",
) -> None:
    """Run multiple step/workflow workers in a single process — one asyncio event loop, one
    Redis connection pool, clean shutdown on SIGTERM/SIGINT.

    Pass an iterable of :class:`Worker` and/or :class:`.WorkflowWorker` instances.  Each
    :class:`Worker` is connected via :func:`~durable_worker.redis_runner.run_redis_worker`;
    each :class:`.WorkflowWorker` via
    :func:`~durable_worker.redis_runner.run_redis_workflow_worker`.  When the process receives
    SIGTERM or SIGINT every handle is closed gracefully (finishing the active job and releasing
    its lock) before the loop exits::

        step_worker    = Worker(group="processing")
        wf_worker      = WorkflowWorker(group="py-workflows")

        @step_worker.step("processing.crunch", blocking=True)
        def crunch(data): ...

        @wf_worker.workflow("pipeline")
        def pipeline(ctx, input): ...

        run_workers([step_worker, wf_worker], redis=redis_url_from_env())

    Blocks until a shutdown signal closes all workers.  For finer control use
    :func:`~durable_worker.redis_runner.run_redis_worker` /
    :func:`~durable_worker.redis_runner.run_redis_workflow_worker` directly.
    """
    import signal as _signal

    from .redis_runner import run_redis_workflow_worker, run_redis_worker
    from .workflow import WorkflowWorker

    async def _main() -> None:
        handles = []
        for worker in workers:
            # Explicit-wins: a worker constructed with its OWN non-default namespace keeps it; otherwise
            # the namespace passed to ``run_workers`` applies (mirrors the TS engine pushing its
            # namespace onto a transport that wasn't given one explicitly).
            worker_namespace = getattr(worker, "namespace", "default")
            effective_namespace = (
                worker_namespace if worker_namespace != "default" else namespace
            )
            if isinstance(worker, WorkflowWorker):
                handle = await run_redis_workflow_worker(
                    worker,
                    group=worker.group,
                    connection=redis,
                    prefix=prefix,
                    namespace=effective_namespace,
                )
            else:
                handle = await run_redis_worker(
                    worker,
                    group=worker.group,
                    connection=redis,
                    prefix=prefix,
                    concurrency=worker.concurrency,
                    namespace=effective_namespace,
                )
            handles.append(handle)

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()

        for sig in (_signal.SIGTERM, _signal.SIGINT):
            try:
                loop.add_signal_handler(sig, lambda: stop.set())
            except (NotImplementedError, RuntimeError):
                pass  # no signal support (e.g. not the main thread) — rely on redelivery

        await stop.wait()
        await asyncio.gather(*[h.close() for h in handles], return_exceptions=True)

    asyncio.run(_main())


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
