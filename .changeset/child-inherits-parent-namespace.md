---
"@dudousxd/nestjs-durable-core": patch
---

Fix: a child run now inherits the namespace/partition of the run it was spawned from, instead of
the namespace of whichever engine executes the parent. Previously, when an operator engine
(`namespace: undefined` — the control plane that recovery-resumes runs of every namespace) executed
a tenant-stamped parent's `ctx.child`/`ctx.gather_children` (or a remote workflow's `startChild`),
the child was stamped `default` and dispatched to the shared/default worker pool. That let a
tenant's child leak off its partition — e.g. a `davi-local` pipeline's `processing` child escaping
to the dev Python workers instead of the local tenant's. The child now carries the parent run's
namespace, so tenant isolation holds regardless of which engine drives the parent. Top-level runs
and explicit `opts.namespace` are unaffected.
