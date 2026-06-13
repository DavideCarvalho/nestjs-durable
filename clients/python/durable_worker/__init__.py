"""durable-worker — Python SDK for running nestjs-durable remote steps.

A worker registers step handlers by name and processes tasks dispatched by the orchestrator.
The wire protocol (task in, result out) is plain JSON and identical across languages, so the
same step name implemented here is callable from a TypeScript workflow via ``ctx.call``.
"""

from .cancellation import Cancelled, CancellationRegistry
from .routing import reply_target
from .worker import FatalError, StepContext, Worker

__all__ = [
    "Worker",
    "FatalError",
    "StepContext",
    "Cancelled",
    "CancellationRegistry",
    "reply_target",
]
__version__ = "0.3.0"
