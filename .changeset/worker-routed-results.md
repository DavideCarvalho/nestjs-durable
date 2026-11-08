---
'@dudousxd/durable-worker': patch
---

A step worker now sends results the way `BullMQTransport` does: back to the engine instance holding the workflow body parked (`replyTo`, while its alive key exists), batched on `<prefix>-results-batch` while an engine reads batches, else one job each on the shared results. With several engines, Nest thin workers and raw `runRedisWorker` fleets no longer make another engine replay the body. The control-channel listener skips the JSON parse for broadcasts that can't be a cancel.
