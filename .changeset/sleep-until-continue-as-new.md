---
"@dudousxd/nestjs-durable-core": minor
---

feat: ctx.sleepUntil + ctx.continueAsNew

- **`ctx.sleepUntil(date | epochMs)`** — durable sleep to an absolute deadline (e.g. "resume at
  midnight"), the absolute-time counterpart of `ctx.sleep(duration)`. Replay-stable.
- **`ctx.continueAsNew(input?)`** — end the current run and hand off to a fresh execution of the same
  workflow with a clean history, for long-running / looping workflows that would otherwise accumulate
  unbounded checkpoints. The next run gets id `<runId>~N`; the handoff is idempotent by that id.
