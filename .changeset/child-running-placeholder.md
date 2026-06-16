---
"@dudousxd/nestjs-durable-core": minor
---

Show an awaited child workflow LIVE in its parent's timeline. `ctx.child` registered the child's signal waiter and suspended but saved no checkpoint, so the parent showed nothing (and no expandable child node) until the child finished. It now writes a `running` placeholder at the child's seq (the same `signal:child:<id>` name the completion overwrites), so the dashboard renders the child node — and can inline-expand it — while it runs. The placeholder is `running` (ignored by replay history, so determinism is untouched) and is overwritten as `completed`/`failed` when the child settles.
