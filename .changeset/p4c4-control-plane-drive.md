---
'@dudousxd/nestjs-durable': minor
---

`DurableControlPlaneModule` now actually DRIVES runs instead of orphaning them: a new internal
`drive?: boolean` option on `DurableModuleOptions` (defaults to `worker !== false` — back-compat)
gates `TimerPoller`'s and `WorkflowRegistrar`'s boot-time poll/recovery independently of `worker`,
and the engine's `runDispatcher` no-op is now selected only when `worker === false && drive !== true`.
`DurableControlPlaneModule.forRoot`/`forRootAsync` set `{ worker: false, drive: true }`: an OPERATOR
control plane that polls pending, recovers crashed runs, resumes due timers, and sweeps timeouts, but
never executes a `@Workflow`/`@Step` body itself — pair it with `remoteByConvention: true` so each
driven run dispatches to a remote tenant worker group instead. A plain `worker: false` (API/dashboard)
instance is unchanged: drive stays off, the no-op dispatcher stays in place.

`DurableWorkerModule` accepts a new `tenant?: string` option: each configured group is served under
`tenantGroup(group, tenant)` (`@dudousxd/nestjs-durable-core`) — `undefined`/`''`/`'default'` stays
the bare group (production unchanged); any other tenant serves `<group>@<tenant>`, matching the group
name an operator control plane's `remoteByConvention` routes that tenant's runs to.

Also corrects `DurableModuleOptions.namespace`'s JSDoc, which still said the default was `'default'`
— it's unset, and omitting it makes the instance an OPERATOR that drives every namespace (mirrors the
already-corrected wording on `WorkflowEngineDeps.namespace`).
