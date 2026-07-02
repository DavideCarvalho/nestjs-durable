# Durable Unified Module + Convention-Default + Alias Removal — Design

**Date:** 2026-07-02
**Status:** Design — approved direction, ready for plan
**Repo:** `@dudousxd/nestjs-durable` (core / nestjs / transport-bullmq / worker / Python)
**Builds on:** `2026-07-02-durable-execution-redesign-design.md` (Phase 1: route-by-handler, shipped as beta `0.0.0-beta-20260702190022`).

## Problem

Phase 1 removed the `group` ceremony from the *routing* model but left three surfaces still carrying the old mental model:

1. **Four ways to declare a role.** `DurableModule` (operator), `DurableWorkerModule` (thin worker), `DurableControlPlaneModule` (drive-only preset), and the `inAppWorker` option — four shapes to answer "what am I?". After Phase 1 only two orthogonal bits actually vary: *do I hold the store?* and *do I execute bodies here?* Everything else (what I serve) is derived from decorators.
2. **`remoteByConvention` is a flag you must remember.** With route-by-name, "dispatch an unregistered workflow to a live worker of that name" is no longer a *convention* — the name IS the queue. A flag that must be turned on for a correct-by-construction behavior is a foot-gun ("forgot the flag → runs dead-end").
3. **Deprecation aliases carried from Phase 1.** `ctx.call`, `remoteStep({group})`, `DurableWorkerModule` `groups`/`tenant`/`concurrencyByGroup`, `BullMQTransport({group})`, Python `Worker(group=/tenant=)`. Phase 1 kept them for a staged migration; the decision now is to make the clean cut.

## Goals

- **One module, role inferred from inputs.** `DurableModule.forRoot(...)` is the only entry point:
  - `{ store, transport }` → **operator**: holds the store, drives every run (retry/orphan/timer), executes registered bodies inline.
  - `{ connection }` (no store) → **thin worker**: store-less, reaches the operator over the transport, subscribes one queue per registered `@Workflow`/`@Step`.
  - `{ store, transport, connection }` → **operator + co-located worker** (the old `inAppWorker`): drives AND executes its own bodies via a co-located per-name subscription (uniform dispatch).
  - `partition?` is the only isolation knob, valid in any shape.
  Absorbs `DurableWorkerModule`, `DurableControlPlaneModule`, and the `inAppWorker` option.
- **Convention dispatch is the default.** Drop the `remoteByConvention` flag. An operator that has no local body for a workflow and sees a live worker of that name dispatches to it; otherwise the run is genuinely unregistered (unchanged error). Route-by-name makes this correct by construction.
- **Remove every Phase-1 deprecation alias.** The canonical surface only: `ctx.remote`/`ctx.step`; `remoteStep({ name, input, output, partition? })`; module `{ store|connection, transport?, partition? }`; `BullMQTransport({ partition? })`; Python `Worker(partition=)`. This is a breaking change — acceptable at 0.x, and flip/squid/Python adopt the whole model at once (they migrate regardless).
- **Canonical config becomes two lines to explain:** operator `{ store, transport }`, worker `{ connection, partition? }` — everything else derived from decorators.

## Non-Goals

- Changing the routing/wire format (Phase 1, unchanged).
- Changing the store, checkpoint format, dashboard, run-gateway, or the tenant/operator transport semantics.
- Migrating `DbTransport`/`SqsTransport` to per-handler subscription (still the documented Phase-1 limitation).
- The flip/squid wiring rewrite — that is downstream adoption after this beta publishes (its own local-test + deploy step, like the Phase-1 tenant work).

## Design

### One `DurableModule.forRoot`, role inferred

`DurableModuleOptions` gains `connection?` and keeps `store?`/`transport?`; the `drive`/`worker`/`inAppWorker`/`remoteByConvention` axes are removed and replaced by inference:

| Inputs | Role | Store | Drives | Executes bodies | Engine token |
|---|---|---|---|---|---|
| `{ store, transport }` | operator | yes | yes | inline | `WorkflowEngine` |
| `{ connection }` | thin worker | no | no | via per-name subscription | `DurableStartClient` |
| `{ store, transport, connection }` | operator + co-located worker | yes | yes | via co-located per-name subscription (uniform dispatch) | `WorkflowEngine` |

- **Validation:** at least one of `store` or `connection` must be present (else throw a clear "a durable module needs either a `store` (operator) or a `connection` (worker)"). `store` requires `transport`. A `connection`-only module that also declares bodies to execute derives its subscription; a `store`-only module executes inline.
- **Provider assembly** branches on `store` presence, producing the current `DurableModule` provider set (engine + StoreRunGateway + drivers + retention) when `store` is set, and the current `DurableWorkerModule` set (DurableStartClient + ProxyRunGateway + thin registrars + `runRedisWorker`) when only `connection`. The `{ store + connection }` case composes the operator set with a co-located `runRedisWorker` (the current `inAppWorker` mechanics: per-workflow-name `RemoteWorkflowExecutor` + co-located runtime, from Phase-1 Task 6.5).
- `DurableModule.forRootAsync` mirrors the inference.

### Convention dispatch as default

- Remove `remoteByConvention` from `DurableModuleOptions` and from `WorkflowEngine` options.
- The engine's `resolveRemoteByConvention` becomes unconditional: when a run's workflow has **no local body** (`hasBody: false` / not registered with a body) and `listWorkerGroups()` reports a live worker under `tenantGroup(sanitizeQueueToken(run.workflow), run.namespace)`, dispatch to it; else the run is unregistered (unchanged `not registered` error). This is exactly today's behavior with the flag forced on — the change is deleting the gate.
- An operator that DOES have the local body still runs it inline (unchanged) — convention only fires for bodies this process lacks.

### Alias removal (the breaking cut)

Delete, across packages:
- **core:** `WorkflowCtx.call` (keep `remote`); `RemoteStepConfig.group` + its mapping in `remoteStep()` (keep `partition`); any `remoteByConvention` option field.
- **nestjs:** `DurableWorkerModule`, `DurableControlPlaneModule`, and the `inAppWorker` option **as separate exports** — folded into `DurableModule`. `groups`/`tenant`/`concurrencyByGroup` are gone with them; `concurrencyByHandler`/`partition` remain.
- **transport-bullmq:** `BullMQTransportOptions.group` (keep `partition`).
- **worker:** `RunRedisWorkerOptions.group`/`tenant` (keep `partition`).
- **Python:** `Worker(group=)`/`Worker(tenant=)` and the `run_redis_worker` `group`/`tenant` aliases (keep `partition`). Bump to the next 0.x.

Keep back-compat re-exports ONLY where trivially free (e.g. a type alias) is explicitly NOT wanted here — this is the clean cut.

## Migration / rollout

- Breaking `minor`-shaped at 0.x (we treat 0.x minors as allowed-breaking, matching the repo's history). One changeset across all four JS packages + a Python bump.
- **Coordinated:** publish a new beta; flip + squid + Python adopt the unified module and the clean API together (downstream, gated) — the same coordinated-fleet deploy Phase 1 already established.
- Because the aliases are gone, downstream adoption is a wholesale rewrite of the durable wiring (module construction + `ctx.call`→`ctx.remote` + drop `group`s). This is expected — the downstream repos migrate to the new model as one change.

## Testing

- **Module inference:** `forRoot({ store, transport })` yields an operator (resolves `WorkflowEngine` real engine, `StoreRunGateway`, drivers); `forRoot({ connection })` yields a thin worker (resolves `DurableStartClient` under `WorkflowEngine`, `ProxyRunGateway`, one `runRedisWorker` per-name subscription, NO store); `forRoot({ store, transport, connection })` yields both (engine + co-located per-workflow-name dispatch). `forRoot({})` and `forRoot({ store })` (no transport) throw the clear validation errors.
- **Convention default:** an operator with no local body for `X` + a live worker `X` dispatches to it with NO flag set (mirror the Phase-1 `remote-by-convention-module.spec.ts`, minus the flag); a truly unregistered workflow still throws `not registered`; the `:`-named sanitization guard from Phase 1 still holds.
- **Alias removal:** each deleted alias no longer type-checks (a compile-fixture or a grep-guard test); the canonical path still works. Regression: the Phase-1 tenant topology (operator + `{ connection, partition }` worker) still round-trips.
- Full gate (`lint` + `typecheck` + `test` + `test:db`) green; Python suite green.

## Open questions

- Whether `DurableWorkerModule`/`DurableControlPlaneModule` should remain as **thin deprecated re-export shims** for ONE beta to ease downstream, or be deleted outright. Recommendation: delete outright (clean cut; downstream migrates wholesale anyway) — revisit only if the flip rewrite proves painful.
