---
'@dudousxd/nestjs-durable-transport-bullmq': patch
---

Closing a transport no longer leaves unhandled "Connection is closed." rejections behind. With reply routing on, the sweep opens a drain worker for each dead engine's reply queue; a `close()` landing a few ms after a sweep closed those workers while they were still connecting, and BullMQ 5 re-emits that failed start-up as an `'error'` with no listener left (an unhandled rejection: a crash under Node's default, a failed run under vitest). `close()` now waits for a sweep in flight, a sweep stops opening drains once `close()` has begun, and every worker gets up to 1 s to finish connecting before it is closed.
