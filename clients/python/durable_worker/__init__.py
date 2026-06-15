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
    current_step,
    log,
    set_process,
    sub,
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
    "log",
    "sub",
    "set_process",
    # Transport bootstrap helpers.
    "run_redis_worker",
    "redis_url_from_env",
    # Author durable workflows in Python (coordinator-driven — the engine owns the durable state).
    "WorkflowWorker",
    "WorkflowContext",
    "WorkflowError",
    "NondeterminismError",
    "StepFailed",
]
__version__ = "0.5.0"
