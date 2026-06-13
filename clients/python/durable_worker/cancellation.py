"""Cooperative cancellation for the Python worker.

The orchestrator broadcasts a ``{"kind": "cancel", "runId": ...}`` control message across every
instance (Redis pub/sub, same channel the TypeScript control plane uses). A long-running handler
can't be force-killed, so cancellation is *cooperative*: a runner subscribes to that channel and
records the cancelled run ids here, and the handler checks ``ctx.cancelled`` (or calls
``ctx.raise_if_cancelled()``) at safe points to bail out early instead of finishing work whose
result will be discarded.
"""

from __future__ import annotations

import threading
from typing import Any, Dict


class Cancelled(Exception):
    """Raised by ``StepContext.raise_if_cancelled`` when the run has been cancelled."""

    def __init__(self, run_id: str) -> None:
        super().__init__(f"run {run_id} was cancelled")
        self.run_id = run_id


class CancellationRegistry:
    """Thread-safe set of cancelled run ids, fed by a control-channel subscription."""

    def __init__(self) -> None:
        self._cancelled: set[str] = set()
        self._lock = threading.Lock()

    def cancel(self, run_id: str) -> None:
        with self._lock:
            self._cancelled.add(run_id)

    def is_cancelled(self, run_id: str) -> bool:
        with self._lock:
            return run_id in self._cancelled

    def clear(self, run_id: str) -> None:
        with self._lock:
            self._cancelled.discard(run_id)

    def on_control_message(self, msg: Dict[str, Any]) -> None:
        """Feed a decoded control message; records the run id when it's a cancel."""
        if isinstance(msg, dict) and msg.get("kind") == "cancel":
            run_id = msg.get("runId")
            if isinstance(run_id, str):
                self.cancel(run_id)
