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
