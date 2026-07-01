---
"@dudousxd/nestjs-durable-core": minor
---

Add operator drive mode: a `WorkflowEngine` constructed with `namespace: undefined` is an
operator control plane — it drives/recovers/resumes runs of EVERY namespace instead of just
its own (`runPending`, `recoverIncomplete`, `resumeDueTimers`, `resume`, and
`completeRemoteDecision` all bypass the namespace guard), and its transport(s) are left on
their own bare/shared prefix (no `useNamespace` call). `resolveRemoteByConvention` now routes
a tenant's run to a tenant-suffixed worker group via the new `tenantGroup(baseGroup, tenant)`
helper: `undefined`/`''`/`'default'` stay bare (`<workflow>`), any other tenant becomes
`<workflow>@<tenant>`. A namespace-scoped engine (`namespace: 'x'`) behaves exactly as before.

`retryWithInput` and dead-letter routing now inherit the original run's `namespace`, so on an
operator a tenant's retry/dead-letter run stays that tenant's (routed to its worker group) instead
of falling back to the bare `'default'` group.

**Behavior change — read before upgrading a shared store.** Omitting `namespace` used to mean the
`'default'` partition; it now means OPERATOR (drives every namespace). A single-pool deployment is
byte-identical (the only namespace is `'default'`, and runs are still persisted as `'default'`). But
if you share ONE state store across multiple pools, EVERY pool must set its own `namespace` — a pool
that omits it will now drive all the other pools' runs. (Correctly-configured shared stores already
set distinct namespaces, so they are unaffected.)
