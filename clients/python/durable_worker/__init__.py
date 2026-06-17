"""durable-worker — Python SDK for running nestjs-durable remote steps.

A worker registers step handlers by name and processes tasks dispatched by the orchestrator.
The wire protocol (task in, result out) is plain JSON and identical across languages, so the
same step name implemented here is callable from a TypeScript workflow via ``ctx.call``.
"""

from .cancellation import Cancelled, CancellationRegistry
from .redis_runner import redis_url_from_env, run_redis_worker
from .routing import reply_target
from .workflow import (
    NondeterminismError,
    StepFailed,
    WorkflowContext,
    WorkflowError,
    WorkflowWorker,
)
from .worker import (
    FatalError,
    StepContext,
    Worker,
    clear_registered_workers,
    current_context,
    current_step,
    log,
    register_worker,
    registered_workers,
    run_all,
    run_workers,
    set_process,
    sub,
    sub_event,
    sub_process,
)

__all__ = [
    "Worker",
    "FatalError",
    "StepContext",
    "Cancelled",
    "CancellationRegistry",
    "reply_target",
    # Context-local step access — record events from anywhere inside a handler without threading ctx.
    "current_step",
    "current_context",
    "log",
    "sub",
    "sub_event",
    "sub_process",
    "set_process",
    # Transport bootstrap helpers.
    "run_redis_worker",
    "redis_url_from_env",
    "run_workers",
    # Auto-discovery: every Worker/WorkflowWorker self-registers; run_all() runs them all.
    "run_all",
    "register_worker",
    "registered_workers",
    "clear_registered_workers",
    # Author durable workflows in Python (coordinator-driven — the engine owns the durable state).
    "WorkflowWorker",
    "WorkflowContext",
    "WorkflowError",
    "NondeterminismError",
    "StepFailed",
]
__version__ = "0.9.0"
