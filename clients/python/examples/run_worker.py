"""Run a Python worker that handles `payments.charge-card` over BullMQ/Redis.

    PYTHONPATH=clients/python python3 clients/python/examples/run_worker.py <prefix>

It consumes the same Redis queues a TypeScript `BullMQTransport` dispatches to, so a TS workflow
can `ctx.call` this Python step. Returns a chargeId prefixed `ch_py_` to prove it ran in Python.
"""

import asyncio
import sys

from durable_worker import Worker
from durable_worker.redis_runner import run_redis_worker

worker = Worker()


@worker.step("payments.charge-card")
async def charge(data):
    return {"chargeId": f"ch_py_{data['amount']}"}


async def main():
    prefix = sys.argv[1] if len(sys.argv) > 1 else "durable"
    await run_redis_worker(worker, prefix=prefix)
    print(f"[python worker] consuming {prefix}-tasks-payments.charge-card", flush=True)
    await asyncio.Event().wait()  # run until killed


if __name__ == "__main__":
    asyncio.run(main())
