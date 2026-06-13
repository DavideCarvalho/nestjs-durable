---
"@dudousxd/nestjs-durable-core": minor
---

feat: retry with backoff on the durable remote path

A durable `ctx.call` (no `timeoutMs`) now re-dispatches a **failed** remote step up to `retries`,
spacing attempts by the configured `backoff`/`backoffMs` — the retry deadline is stamped on the
failed checkpoint as `wakeAt` (clock-space, persisted), so it's stable across replays and survives a
crash. A worker can opt out per-failure by throwing an error with `retryable: false` (now carried
through the wire by the step runner, alongside `code`), which the engine treats as a final verdict.
