"""A Python durable worker for the cross-language remoteStep test.

Reads one RemoteTask JSON per line on stdin, runs it through `durable_worker.Worker.process_task`
(the same code path the BullMQ/SQS/DB runners use), and writes the StepResult JSON on stdout.
"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(sys.argv[1]))

from durable_worker import Worker  # noqa: E402

worker = Worker()


@worker.step("py.score")
def score(data):
    return {"score": len(data["text"]) * 10, "lang": "python"}


@worker.step("py.reject")
def reject(data):
    raise ValueError(f"cannot score {data['text']!r}")


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    result = worker.process_task(json.loads(line))
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
