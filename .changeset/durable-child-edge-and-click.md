---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-dashboard": patch
---

Keep an awaited child workflow attached to its parent after it finishes, and stop a child node-click from navigating away.

- **core:** `getRunChildren` now discovers an awaited `ctx.child` from the persisted `signal:child:<id>` checkpoint, not only the live `child:<id>` signal waiter. The waiter is consumed the instant the child settles, so a completed parent (or completed child) used to drop out of the parent→children tree — making an inline child view vanish the moment its work finished. The checkpoint persists across completion, so the edge is now stable for finished runs too.
- **dashboard:** clicking a child-workflow node (graph) or row (spans) now opens its step detail like any other step, instead of immediately navigating to the child run. Navigating is the dedicated `child ↗` badge's job — so you can inspect a child step (and inline-expand it) without leaving the run.
