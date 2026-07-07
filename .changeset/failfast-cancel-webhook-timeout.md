---
"@dudousxd/nestjs-durable-core": minor
---

`ctx.all({ mode: 'failFast' })` now cancels the surviving siblings when it throws (best-effort —
a child mid-step observes the cancellation at its next checkpoint), instead of leaving them
running with ignored results. `DurableWebhook.wait()` accepts `{ timeoutMs }` with the same
durable-deadline semantics as `waitForSignal` (throws `SignalTimeoutError` past the deadline;
deadline stamped once and stable across replays).
