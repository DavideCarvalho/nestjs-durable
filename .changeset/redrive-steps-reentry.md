---
'@dudousxd/nestjs-durable-core': patch
---

The post-release re-check for `ctx.step` results (0.75.2) no longer replays a run whose result was settled on the same instance. That result's own resume already drives the run — `execute` admits it into a lease this instance holds — so the re-drive ran the body an extra time, and concurrently with it when the resume was still in flight. A workflow whose body has effects between steps broke on that: an agent turn on the in-process transport recorded its tool call twice and lost the tool output. The re-drive now skips steps settled here, and takes the lease atomically before resuming, so it only ever drives a run nothing else is driving — the case it exists for, a result settled by another instance while this one held the lease.
