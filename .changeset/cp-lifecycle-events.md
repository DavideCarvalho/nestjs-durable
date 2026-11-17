---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-diagnostics": minor
"@dudousxd/nestjs-durable-telescope": minor
---

The control plane records every tenant's workflow lifecycle, each event attributed to its tenant app.

- **core**: `runTraceId(runId)` (the run's trace id, the same in every process), `RunAppStamper` (stamps `app: <tenant partition>` on every event of a tenant's run, step events included, through a per-run cache with one store read for an unseen run; emission order kept, a run's events wait only behind its own read, failed or timed-out reads are not cached), `tenantAppOf` and `controlPlaneAttribution(options, getRun)`.
- **diagnostics**: on `topology: 'control-plane'`, `DurableDiagnosticsModule` emits each tenant event with `app` in the payload and on the envelope (`emit`'s `app` option, stamped by `@dudousxd/nestjs-diagnostics` 0.12+, ignored by older versions) and with the run's trace id. The control plane's own runs are unchanged. A store-less tenant pod emits nothing (it used to fail at bootstrap on the missing `engine.subscribe`). `attachDurableDiagnostics(engine, { tenants })` for manual wiring. Requires core 0.94+.
- **telescope**: on a control plane the watcher tags every entry of a tenant's run `app:<partition>` (and records `app` in its content). Every `durable.*` data provider accepts `query.app`: store reads by that namespace, worker groups `<name>@<app>`, recorded entries by their `app:<app>` tag. Requires core 0.94+.
