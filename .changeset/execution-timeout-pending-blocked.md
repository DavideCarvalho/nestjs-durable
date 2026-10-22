---
"@dudousxd/nestjs-durable-core": minor
---

`executionTimeout` now also cancels runs that are `pending` or `blocked`.

The sweep used to look only at `running` and `suspended` runs. A run no worker ever picked up (`pending`), or one no live worker has the capabilities for (`blocked`), never expired, while a run that started and then hung was cut off at its deadline. All four statuses are now swept, counted from the run's `createdAt` as before. A run in `cancelling` is still left alone, so its saga undo finishes and it ends `cancelled` on its own.

If a workflow has an `executionTimeout` and its runs can wait in the queue (or `blocked`) longer than that, those runs are now cancelled with `code: 'execution_timeout'` when they used to wait.
