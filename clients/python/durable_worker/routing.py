"""Reply routing for a worker that consumes several transports (multi-broker failover).

The orchestrator stamps each task with the id of the transport it was dispatched on
(``task["transport"]``). A worker that consumes more than one broker must send the *result* back on
the same broker — so failover is symmetric and the worker never picks a transport itself, it just
replies where it was told. This is a pure lookup over a ``{id: reply_target}`` mapping with a sane
fallback for the single-transport / unknown-id case.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, TypeVar

T = TypeVar("T")


def reply_target(task: Dict[str, Any], targets: Dict[str, T]) -> Optional[T]:
    """The reply target for ``task`` by its ``transport`` id; falls back to the lone target when the
    id is absent (single transport) or unknown. Returns ``None`` only if ``targets`` is empty."""
    if not targets:
        return None
    transport_id = task.get("transport")
    if isinstance(transport_id, str) and transport_id in targets:
        return targets[transport_id]
    if len(targets) == 1:
        return next(iter(targets.values()))
    return None
