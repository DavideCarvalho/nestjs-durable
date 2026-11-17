---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable-transport-bullmq": minor
---

A `DurableModule` tenant (a `connection`, no `store`) now behaves like a standalone app for the basics. `MyWorkflow.start()` works on a tenant: the class statics are bound to the tenant's start client. `version`, `priority`, `startAt` and `concurrency` travel on `StartRunMessage` and the control plane applies them. A start whose workflow no live worker serves yet is created `blocked` with `error.code: 'no_live_worker'` and starts once a worker (declaring the pinned version, if any) is live, instead of being dropped. A start the quota refuses is recorded as a `failed` run (`concurrency_limit`). A start the control plane fails to create is redelivered with backoff, idempotent by run id. A workflow turn dispatched to a remote worker now takes `reconcileMs` (5 min) as its re-drive deadline when `remoteAdvanceSilenceMs` is unset, so a run whose worker died mid-turn is re-driven instead of hanging; `reconcileMs: 0` keeps the old wait. A pinned start resolved by convention routing is accepted when the live workers declare that version. Due runs nothing can resolve are retried with a back-off instead of on every timer poll.
