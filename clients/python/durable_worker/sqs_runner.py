"""Run a :class:`Worker` against the SQS transport.

Long-polls the orchestrator's per-group tasks queue and sends results on the shared results queue —
the same queues a TypeScript ``SqsTransport`` uses, so steps interoperate across languages. The wire
body is the documented ``RemoteTask`` / ``StepResult`` JSON. Requires the optional ``sqs`` extra:
``pip install durable-worker[sqs]``.

SQS has no push model, so this is a blocking poll loop (unlike the async ``redis_runner``). Run it in
its own process/thread; pass a ``threading.Event`` as ``stop`` to shut it down.
"""

from __future__ import annotations

import json
import threading
from typing import Any, Dict, Optional

from .worker import Worker


def _queue_names(prefix: str, group: str) -> tuple[str, str]:
    # Must match the TS SqsTransport fallback names: '<prefix>-tasks-<group>' and '<prefix>-results'.
    return f"{prefix}-tasks-{group}", f"{prefix}-results"


def _is_ours(message: Dict[str, Any], marker: Optional[str]) -> bool:
    """When sharing a queue with a legacy consumer, only take messages tagged with ``marker``."""
    if marker is None:
        return True
    attr = (message.get("MessageAttributes") or {}).get(marker)
    return bool(attr) and attr.get("StringValue") == "1"


def handle_message(worker: Worker, body: str) -> Dict[str, Any]:
    """Pure core: parse a task message body and produce the result dict. No SQS involved — testable."""
    task = json.loads(body)
    return worker.process_task(task)


def run_sqs_worker(
    worker: Worker,
    *,
    group: str,
    prefix: str = "durable",
    region: Optional[str] = None,
    endpoint_url: Optional[str] = None,
    tasks_queue_url: Optional[str] = None,
    results_queue_url: Optional[str] = None,
    wait_time_seconds: int = 20,
    visibility_timeout: int = 30,
    marker: Optional[str] = None,
    client: Any = None,
    stop: Optional[threading.Event] = None,
) -> None:
    """Block and process tasks for ``group`` until ``stop`` is set.

    Queue URLs are resolved by name (``<prefix>-tasks-<group>`` / ``<prefix>-results``) unless you
    pass ``tasks_queue_url`` / ``results_queue_url`` to reuse existing queues. Pass ``client`` to
    inject a preconfigured boto3 SQS client (otherwise one is created from ``region`` /
    ``endpoint_url``).
    """

    if client is None:
        import boto3  # imported lazily so the SDK works without boto3

        client = boto3.client("sqs", region_name=region, endpoint_url=endpoint_url)

    tasks_name, results_name = _queue_names(prefix, group)
    tasks_url = tasks_queue_url or client.get_queue_url(QueueName=tasks_name)["QueueUrl"]
    results_url = results_queue_url or client.get_queue_url(QueueName=results_name)["QueueUrl"]
    marker_attrs = (
        {marker: {"DataType": "String", "StringValue": "1"}} if marker else {}
    )
    stop = stop or threading.Event()

    while not stop.is_set():
        received = client.receive_message(
            QueueUrl=tasks_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=wait_time_seconds,
            VisibilityTimeout=visibility_timeout,
            MessageAttributeNames=["All"] if marker else [],
        )
        for message in received.get("Messages", []):
            receipt = message["ReceiptHandle"]
            if not _is_ours(message, marker):
                # Not ours (shared queue): release immediately so the legacy consumer can take it.
                client.change_message_visibility(
                    QueueUrl=tasks_url, ReceiptHandle=receipt, VisibilityTimeout=0
                )
                continue
            result = handle_message(worker, message.get("Body") or "{}")
            client.send_message(
                QueueUrl=results_url,
                MessageBody=json.dumps(result),
                MessageAttributes=marker_attrs,
            )
            client.delete_message(QueueUrl=tasks_url, ReceiptHandle=receipt)
