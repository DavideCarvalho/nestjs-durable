"""Workflows declared as classes: ``run`` is the body, ``@on_error`` methods are its handlers."""

from __future__ import annotations

import pytest

from durable_worker import FatalError, Worker, on_error, workflow_name
from durable_worker.redis_runner import _build_descriptor
from durable_worker.workflow import WorkflowWorker, process_workflow_task


class InvalidLine(FatalError):
    code = "invalid_line"


class Rejections:
    def __init__(self) -> None:
        self.recorded: list = []


def _task(workflow: str, input_: object, history: list | None = None) -> dict:
    return {
        "taskId": "t",
        "runId": "r1",
        "workflow": workflow,
        "workflowVersion": "1",
        "input": input_,
        "history": history or [],
    }


def test_a_class_registers_its_run_and_its_handler_methods():
    worker = Worker(auto_register=False)
    rejections = Rejections()

    @worker.workflow("line", version="2", factory=lambda cls: cls(rejections))
    class LineWorkflow:
        def __init__(self, rejections: Rejections) -> None:
            self.rejections = rejections

        def run(self, _ctx, line):
            return {"ok": 1, "n": line["n"]}

        @on_error(InvalidLine)
        @on_error("bad_row")
        def reject_line(self, _ctx, failure):
            self.rejections.recorded.append(failure["input"])
            return {"ok": 0, "failed": 1}

        @on_error()
        def other(self, _ctx, _failure):
            return {"ok": 0, "failed": 1}

    assert process_workflow_task(worker._workflows, _task("line", {"n": 3}))["output"] == {
        "ok": 1,
        "n": 3,
    }
    handled = process_workflow_task(
        worker._workflows,
        _task("line.onError.reject_line", {"runId": "r0", "input": {"n": 3}, "error": {}}),
    )
    assert handled["output"] == {"ok": 0, "failed": 1}
    # The handler is bound to the instance the factory built, dependencies included.
    assert rejections.recorded == [{"n": 3}]

    wire = _build_descriptor(worker, None, "default", lambda name: name).to_wire()
    by_name = {r["name"]: r for r in wire["registrations"]}
    routes = sorted(by_name["line"]["onError"], key=lambda r: (r.get("code") or "", r["workflow"]))
    assert routes == [
        {"workflow": "line.onError.other"},
        {"code": "bad_row", "workflow": "line.onError.reject_line"},
        {"code": "invalid_line", "workflow": "line.onError.reject_line"},
    ]
    assert by_name["line.onError.other"]["version"] == "2"


def test_a_registered_class_is_a_workflow_reference():
    worker = WorkflowWorker("files")

    @worker.workflow("line")
    class LineWorkflow:
        def run(self, _ctx, line):
            return line

    @worker.workflow("file")
    def file(ctx, lines):
        return ctx.all_settled(LineWorkflow, lines)

    decision = process_workflow_task(worker._workflows, _task("file", [{"n": 1}]))
    assert workflow_name(LineWorkflow) == "line"
    assert [c["workflow"] for c in decision["commands"] if c["kind"] == "startChild"] == ["line"]


def test_class_registration_errors():
    worker = Worker(auto_register=False)

    with pytest.raises(TypeError, match="needs a run"):

        @worker.workflow("broken")
        class NoRun:
            pass

    class NotRegistered:
        def run(self, _ctx):
            return None

    with pytest.raises(TypeError, match="not a registered workflow"):
        workflow_name(NotRegistered)

    with pytest.raises(ValueError, match="for code"):

        @worker.workflow("dup")
        class Duplicate:
            def run(self, _ctx):
                return None

            @on_error("x")
            def a(self, _ctx, _f):
                return None

            @on_error("x")
            def b(self, _ctx, _f):
                return None


def test_a_function_keeps_its_inline_on_error():
    worker = Worker(auto_register=False)

    @worker.workflow("line")
    def line(_ctx, _input):
        return None

    @line.on_error("invalid_line")
    def reject_line(_ctx, _failure):
        return None

    assert worker._workflow_meta["line"]["on_error"] == [
        {"code": "invalid_line", "workflow": "line.onError.reject_line"}
    ]
