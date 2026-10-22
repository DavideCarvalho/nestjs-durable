---
"@dudousxd/nestjs-durable-transport-sqs": patch
---

SqsTransport's poll loops no longer stop consuming on the first failure, and a received batch no longer runs twice.

- A result handler that throws, a result `SendMessage` that fails, a message body that isn't JSON or a failing queue-URL resolution is reported through the new `onError` option (default `console.error`) and the loop moves on. The message is not deleted: SQS redelivers it after its visibility timeout, and a redrive policy moves one that keeps failing to a DLQ. These used to reject the loop's promise (an unhandled rejection) and leave the instance consuming nothing.
- Every message of a received batch is kept invisible (`ChangeMessageVisibility` every third of the timeout) while it waits or runs. The messages behind a slow one used to reappear and run on another worker.
- A `taskQueueUrl` resolver is now called once per group and cached, as documented.
