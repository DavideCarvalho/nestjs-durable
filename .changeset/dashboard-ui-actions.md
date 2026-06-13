---
"@dudousxd/nestjs-durable-dashboard": patch
---

feat(dashboard): "Cancel + Undo" action and the `dead` status

The run view gains a **Cancel + Undo** button that cancels with saga compensation
(`durableClient.cancel(id, { compensate: true })`) alongside the plain Cancel, and the new `dead`
dead-letter status is rendered (filter chip + badge colour).
