---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

**A dispatched step now routes by the RUN's tenant, not by the engine's.** This closes a tenant-isolation hole: an operator that had a workflow registered locally executed a tenant's run in-process and dispatched its steps to the BARE group token — so on a shared broker the deployed cluster's workers ran that tenant's work, reaching for the tenant's data in the wrong place.

**core**

- Every dispatched-step routing token is now `tenantGroup(sanitizeQueueToken(step.name), step.partition ?? run.namespace)` (the new internal `stepGroup`), applied uniformly across the durable dispatch, the re-dispatch, the `ensureRoutable` guard, the `timeoutMs` in-memory path, and saga compensations. Previously all of these read only `StepDef.partition` — a field no code path has populated since `remoteStep({ group })` was removed, so **every** step dispatched bare regardless of topology.
- This restores the symmetry the wire always assumed: an out-of-process worker already stamps its own partition onto each `call` command it emits (the worker SDK's `resolveCallGroup`); the in-process executor had no equivalent. Now both derive the same token.
- Child runs were already inheriting the parent's namespace — unchanged.

**nestjs**

- `topology: { role: 'control-plane', tenant }` now maps `tenant` onto the node's worker-routing `partition` as well as its `namespace`, so a tenant-scoped control plane SUBSCRIBES the same `<name>@<tenant>` tokens its engine DISPATCHES to. Without this the node would enqueue onto queues it is not itself consuming.
- `DurableStepRegistrar` passes that partition when registering each `@Step` on the transport.
- A node's serving `partition` now also falls back to its own `namespace` when not declared, so the documented local-dev recipe (a namespaced engine on a private Redis, `docs/namespaces.md`) keeps working end-to-end with no extra wiring. An explicit `partition` still wins.

**transport-bullmq**

- `handle(name, fn, partition?)` takes an optional per-registration partition that overrides the transport's constructor partition — a tenant-scoped control plane shares ONE transport for dispatch and for serving its handlers.

**Also — opt-in `blockOnAbsentWorker`.** A new engine/module option: when a step is dispatched to a routing token with NO live worker, park the run `blocked` (a loud, dashboard-visible `worker.absent` state) instead of enqueuing into a queue nobody consumes. It self-heals — the blocked-recovery poll re-drives the moment a worker appears — and turns "a run is stuck because its tenant pool is offline" from a silent job sitting in the queue into a visible waiting state. Default `false`, so the durable-queue enqueue-before-the-worker-exists contract is unchanged; turn it on for a control plane routing to tenant pools that can be offline. (`BlockedDispatch`/`DispatchDiagnostics` gain a `worker.absent` code alongside the capability/protocol ones.)

**dashboard**

- A `blocked` run now renders as the existing **no-worker** display state — the warm "act on this" colour, the "N runs have no worker" attention banner, and a detail naming the group it's waiting on (parsed from the parked reason). Previously a `blocked` run showed a flat, uncoloured badge and never joined the banner (that banner keys off queue backlog, which a parked run doesn't create). So a run waiting on an offline tenant pool is now visible at a glance in `/durable`, not just in the run's I/O panel.

**Compatibility.** `tenantGroup` maps `undefined` / `''` / `'default'` to the bare token, so a single-tenant deployment and every `default`-namespace run keep byte-identical wire names. The behavior changes only for runs stamped with a real tenant — which is the bug. If you set `namespace`/`tenant` purely as a store-partitioning axis while your workers subscribe BARE tokens (e.g. a local stack whose isolation actually comes from a private Redis or a distinct `prefix`), those steps now dispatch to `<name>@<tenant>`: give the worker the matching `partition`, or drop the tenant and keep isolating by transport `prefix`.
