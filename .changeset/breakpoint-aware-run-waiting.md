---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
---

**Breakpoint-aware `RunWaiting` + bulk `RunGateway.waitingFor`.** `ctx.breakpoint()` registers a
signal waiter under the hood (`bp:<runId>:<seq>`, resumed by `engine.continue`), but `RunWaiting` —
what the dashboard/an app names a suspended run as being parked on — had no `breakpoint` case, so a
paused run showed up as waiting on a raw-token `signal` named `bp:r1:7`. `RunWaiting.on` gains a
`'breakpoint'` variant (`classifyWaiterToken` now recognises the `bp:` prefix); this also fixes how
`listRuns` labels breakpoint waiters, since it shares the same classifier.

New `RunGateway.waitingFor(runIds: string[]): Promise<Record<string, RunWaiting>>` — bulk-resolve
what a set of runs is currently parked on, for a consumer with its own filtered/paginated run listing
that needs "which of MY runs are stuck at a breakpoint" without re-deriving the waiter scan or
querying `durable_step_checkpoints` directly. Implemented on `StoreRunGateway` (two bulk store scans,
never one query per id) and forwarded by `ProxyRunGateway` over the existing run-request/reply
transport (one request for the whole id list); the operator-side `RunRequestResponder` scopes the
reply to runs the requesting tenant actually owns.
