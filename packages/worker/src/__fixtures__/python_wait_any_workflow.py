"""A Python durable workflow for the cross-language waitForAny test.

Reads one WorkflowTask JSON per line on stdin, replays it through
`durable_worker.workflow.process_workflow_task` (the same code path the BullMQ/SQS/DB runners use),
and writes the WorkflowDecision JSON on stdout.
"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(sys.argv[1]))

from durable_worker.workflow import process_workflow_task  # noqa: E402


def race(ctx, _input):
    first = ctx.wait_for_any(
        "race",
        {"go": ctx.signal_wait("go"), "stop": ctx.signal_wait("stop"), "late": ctx.timer(3_600_000)},
    )
    nxt = ctx.wait_signal("stop")
    return {"first": first, "next": nxt}


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    decision = process_workflow_task({"race": race}, json.loads(line))
    sys.stdout.write(json.dumps(decision) + "\n")
    sys.stdout.flush()
