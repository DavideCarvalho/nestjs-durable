---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/durable-worker': minor
'@dudousxd/nestjs-durable': minor
---

Let a deployment answer "what workflows exist here", from what workers announce.

A console that offers "call this existing workflow" needs a picker, and nothing could build one.
`engine.workflowBody(name, version)` answers only for the process asking, and a missing body is
ambiguous BY DESIGN: it means "not registered here", but equally "registered via `registerRemote`
against another SDK" or "a group this pod resolves by convention against a live worker". A picker
built on that inference would show different options depending on which replica served the request —
the same cross-replica incoherence a registry is supposed to remove.

So registration is now ANNOUNCED. `WorkerDescriptor` gains an optional `registrations` — name,
version, group, requires, origin — that a worker publishes for the bodies it holds and the queues it
consumes. The rule is "announce only what you can run": nothing announces a workflow it merely knows
how to route to, because that claim says nothing about a live executor existing. `runRedisWorker`
(both the thin worker and the co-located in-app one) now publishes the full descriptor alongside the
heartbeat it already stamped, and `@Workflow`'s `version`/`requires`/`origin` flow into it — the
worker states what the decorator states, and an option left off stays un-stated.

`engine.announcedWorkflows()` folds the live descriptors into one entry per `name@version`. It costs
one scan of the advertisement keyspace PER CALL: nothing is added to the poll loop, and no pod holds
a table of the fleet's registrations. It is namespace-scoped like every other poll surface, so an
operator sees every tenant and a tenant engine sees only its own.

LIVENESS is the descriptor key's TTL. The announcement rides a key written with the worker-heartbeat
TTL and refreshed by the same beat, so a worker that dies takes its announcements with it — there is
no expiry bookkeeping to get wrong, and no way for an announcement to outlive its worker. The
resolution is the TTL, so an entry can name a worker that died within the last beat window; that is
the staleness the capability router already accepts when it reads the same keys to decide dispatch.

DISAGREEMENT is reported, never resolved. Two workers announcing one `name@version` from different
groups, origins or capability demands produce ONE entry listing every distinct claim plus the axes
they differ on. Two origins is a name collision between packages; two `requires` sets is two code
versions under one version tag; two groups means nobody can know which queue to dispatch to. Each is
a human's call, so the aggregate surfaces it instead of silently picking a winner. Silence is not a
claim — an announcer that stated no origin does not disagree with one that did.

CROSS-SDK, today. Every SDK already publishes `workflows: string[]`, and a bare name is accepted as a
valid unversioned announcement, so a worker that has not adopted `registrations` is listed rather
than invisible. The Python SDK publishes the richer form too (`@worker.workflow("pipeline",
version="2", origin="...")`), and its hash projection matches the TS one byte for byte — pinned by a
new golden fixture both suites read. A descriptor that announces nothing hashes EXACTLY as before, so
every ETag already published stays valid.

STEPS are deliberately out of scope, and the reason is written down in `handshake/announced` and the
handshake docs: a step is not addressable from outside a run — it has a `(runId, seq)` position in
one workflow's history, `ctx.step` is only callable from inside a replaying body, and no engine entry
point starts one on its own. "Call this step" is not an operation the engine can perform, so a picker
offering steps would offer something that does not exist.
