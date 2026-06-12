"""Core worker: a name->handler registry and the pure task->result dispatch.

Transport (Redis/BullMQ/NATS) is intentionally separate — `process_task` is a pure function of
the task, so it is fully testable without any broker. A transport adapter just feeds tasks in
and ships results out.
"""

from __future__ import annotations

import asyncio
import inspect
import time
from typing import Any, Awaitable, Callable, Dict, Union

Handler = Callable[[Any], Union[Any, Awaitable[Any]]]


class FatalError(Exception):
    """Raise inside a handler to signal a non-retryable failure (mirrors the TS ``FatalError``).

    The engine will not retry the step regardless of its ``retries`` setting.
    """

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


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

    def step(self, name: str) -> Callable[[Handler], Handler]:
        """Decorator registering ``fn`` as the handler for step ``name``."""

        def register(fn: Handler) -> Handler:
            self._handlers[name] = fn
            return fn

        return register

    def handles(self, name: str) -> bool:
        return name in self._handlers

    def process_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Run the handler for ``task`` and return a wire-format result.

        Pure and synchronous from the caller's view (async handlers are awaited internally), so a
        transport can simply ``result = worker.process_task(task); send(result)``.
        """

        base = self._base(task)
        handler = self._handlers.get(task["name"])
        if handler is None:
            return self._no_handler(base, task["name"])
        try:
            output = handler(task.get("input"))
            if inspect.isawaitable(output):
                output = asyncio.run(output)
            return {**base, "status": "completed", "output": output}
        except Exception as err:  # noqa: BLE001
            return self._failure(base, err)

    async def aprocess_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Async variant — awaits async handlers in the current loop. Use from a transport that
        already runs inside an event loop (e.g. the BullMQ runner)."""

        base = self._base(task)
        handler = self._handlers.get(task["name"])
        if handler is None:
            return self._no_handler(base, task["name"])
        try:
            output = handler(task.get("input"))
            if inspect.isawaitable(output):
                output = await output
            return {**base, "status": "completed", "output": output}
        except Exception as err:  # noqa: BLE001
            return self._failure(base, err)

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
    def _no_handler(base: Dict[str, Any], name: str) -> Dict[str, Any]:
        return {
            **base,
            "status": "failed",
            "error": {"message": f"no handler for {name}", "retryable": False},
        }

    @staticmethod
    def _failure(base: Dict[str, Any], err: Exception) -> Dict[str, Any]:
        if isinstance(err, FatalError):
            return {
                **base,
                "status": "failed",
                "error": {"message": str(err), "code": err.code, "retryable": False},
            }
        return {**base, "status": "failed", "error": {"message": str(err)}}
