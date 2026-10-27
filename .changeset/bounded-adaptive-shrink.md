---
'@dudousxd/durable-worker': patch
---

A queuing tick takes at most a quarter off the adaptive concurrency limit (and at least one slot),
instead of cutting it to `limit × gradient`. The window is the last 100 steps, a fraction of a second
of a busy worker's work, so one slow moment read as deep queuing and dropped a worker to one or two
slots, which then took ten ticks to grow back by √limit. Queuing that persists still halves the limit
in under three ticks. The Python `durable-worker` 0.26.3 makes the same decision.
