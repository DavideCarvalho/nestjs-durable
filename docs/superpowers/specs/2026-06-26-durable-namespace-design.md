# Durable namespace — run partitioning for a shared state store

**Date:** 2026-06-26
**Status:** Design — pending implementation
**Scope:** `@dudousxd/nestjs-durable-core`, `@dudousxd/nestjs-durable-store-mikro-orm` (critical path), parity in `store-drizzle` / `store-typeorm` / `store-prisma`; plus flip-nestjs wiring.

## Problem

The poll-based dispatch path is global over the state store, with **no environment scoping**. Every worker, on every tick, calls:

- `timer-poller.ts` → `engine.runPending()` → `store.listPendingRuns(100)`
- → `engine.recoverIncomplete()` → `store.listIncompleteRuns()`
- → `engine.resumeDueTimers()` → `store.listDueTimers(now)`
- → `engine.sweepTimeouts()` → `store.listRuns({ workflow, status })`

None of these filter by who owns the run. So when **two non-interchangeable worker pools share one store** — the canonical case being a developer running the app locally (local MinIO, local code) while pointed at the shared **dev RDS**, alongside the live dev cluster (real S3, deployed code) — each pool treats the other's runs as its own work.

Observed failure: a locally-triggered `pipeline` run creates its `ingestion` child as `pending` in dev RDS; a dev-cluster pod polls the shared store, leases the child, and executes it from `/app/dist` against **real AWS S3**, where the file (present in local MinIO) does not exist → `NoSuchKey`. The leak is **bidirectional**: a local worker likewise picks up dev-created runs (seen via a dev run leased by a local instance id).

The BullMQ transport is per-environment (separate Redis), so dispatch *nudges* don't cross — but the store poll is the reliable, broker-agnostic pickup path, and it is global. The lease/heartbeat mechanism only protects a run once it is `running` (a live worker renews its lease; `recoverIncomplete` only steals an acquirable lease). The unprotected window is `pending` — a run with no owner yet, which the first free poller wins.

## Goal / non-goals

**Goal:** let a worker pool execute only the runs that belong to it, when the state store is shared across pools — without changing behavior for the single-pool (current) deployment.

**Non-goals:**
- Isolating the durable tables onto a separate connection/schema (a different approach, separately viable since the durable entities are `EntitySchema`-based; out of scope here).
- Making a local Python `durable-worker` available for the remote `processing` phase (see Caveats).
- Read/inspection scoping (the dashboard and per-id lookups stay global — see "Execution vs read").

## The rule

> A worker only **picks up, recovers, resumes-timers-for, and times-out** runs in its own namespace. Every run is stamped, at creation, with the namespace of the engine that created it. An unset namespace is `"default"` → byte-identical to today.

- Local: `DURABLE_NAMESPACE=davi-local`
- Dev / prod: unset → `"default"` (existing rows already read as `"default"`).

A child run inherits the creating engine's namespace automatically (a child created by a local engine is local). This closes both directions of the leak: dev never lists local pendings, and local never lists dev pendings.

## Data model

New column on `durable_workflow_runs`:

```
namespace VARCHAR(255) NOT NULL DEFAULT 'default'
```

New composite index for the hot poll path (runs every ~1s on every worker):

```
INDEX (namespace, status, createdAt)
```

`status`-leading queries that also constrain namespace (`listIncompleteRuns`, `sweepTimeouts`) are covered by this index ordering; `listDueTimers` filters `wakeAt` + namespace and keeps its existing `wakeAt` index plus the namespace predicate.

A dedicated column (not a `searchAttributes` JSON key) because this is a hot, indexed filter on every tick, not an ad-hoc query facet.

`autoSchema: true` already does additive `add column` / `add index` safely on boot, so existing deployments self-migrate; a checked-in migration is provided for environments that run migrations explicitly. Existing rows default to `"default"` (the dev/prod namespace), so nothing changes for them.

## API / interface changes

### core (`@dudousxd/nestjs-durable-core`)

- `WorkflowEngineDeps` (engine config): add `namespace?: string` (default `"default"`). Stored as `this.namespace`.
- `WorkflowRun`: add `namespace: string`.
- `RunQuery`: add `namespace?: string` (ANDed with the other predicates; used by `sweepTimeouts`).
- `StateStore`:
  - `listPendingRuns(limit: number, namespace?: string)`
  - `listIncompleteRuns(namespace?: string)`
  - `listDueTimers(nowMs: number, namespace?: string)`
  - `listRuns(query)` already takes `RunQuery` — gains the `namespace` field.
  - `createRun` persists `run.namespace`.

When `namespace` is `undefined`, every list method behaves exactly as today (no filter) — so the change is source- and behavior-compatible for callers that don't pass it.

### engine (`engine.ts`)

- Stamp on creation: in `start` / child creation / remote `startChild`, set `run.namespace = this.namespace` before `store.createRun(run)`.
- Filter the four poll paths:

| Path | Today | After |
| --- | --- | --- |
| `runPending` | `store.listPendingRuns(100)` | `store.listPendingRuns(100, this.namespace)` |
| `recoverIncomplete` | `store.listIncompleteRuns()` | `store.listIncompleteRuns(this.namespace)` |
| `resumeDueTimers` | `store.listDueTimers(now)` | `store.listDueTimers(now, this.namespace)` |
| `sweepTimeouts` | `store.listRuns({ workflow, status })` | `store.listRuns({ workflow, status, namespace: this.namespace })` |

### store-mikro-orm (critical path)

- `entities.ts`: add `namespace` to the `WorkflowRunEntity` class and to the `EntitySchema` built by `durableEntities` (default `"default"`, indexed via the composite index).
- `schema.ts` (`ensureMikroOrmDurableSchema`): additive `add column` + `add index`.
- Implement the namespace predicate in `listPendingRuns`, `listIncompleteRuns`, `listDueTimers`, and the `listRuns` query builder. A `undefined` namespace omits the predicate (back-comat).
- Checked-in migration: `ALTER TABLE durable_workflow_runs ADD COLUMN namespace ... DEFAULT 'default'` + index.

### Adapter parity (drizzle / typeorm / prisma)

Same column + same four-method filter, so a namespace-partitioned store works regardless of backend. Mechanical mirror of the mikro-orm change. **Decision needed from review:** ship parity in the same PR, or land mikro-orm first (the only backend flip uses) and follow up. Until an adapter implements it, it ignores the param and stays global (documented as "namespace not yet enforced on this adapter").

## Execution vs read

Namespace governs **who executes**, not **who sees**. Only the pickup/execution poll paths filter. The read/inspection paths stay global:

- `/durable` dashboard listing (`listRuns` without a namespace predicate) — ops keeps full visibility across pools.
- `getRun(id)` and per-id control-panel lookups (e.g. the pipeline-runs page) — unaffected; a run is findable by id regardless of namespace.

So the dashboard's own `listRuns` calls pass no namespace; only the engine's `sweepTimeouts` passes one.

## Backward compatibility

- Column defaults to `"default"`; existing rows read as `"default"`.
- An engine with no `namespace` configured runs as `"default"` and lists/stamps exactly as today.
- A single-pool deployment is unaffected end-to-end.
- First deploy with the column: dev/prod stay `"default"` (one pool, no behavior change); only a developer opting into `DURABLE_NAMESPACE=davi-local` partitions off.

## flip-nestjs wiring

In `durable-orchestrator.module.ts`, inside the `forRootAsync` `useFactory`:

```ts
namespace: process.env.DURABLE_NAMESPACE ?? "default",
```

Local `.env`: `DURABLE_NAMESPACE=davi-local`. Dev/prod leave it unset.

## Caveats

- **Remote `processing` phase.** `processing` is a remote workflow executed by the Python `durable-worker` over `PROCESSING_WORKFLOW_GROUP` (BullMQ). The run row is driven by the NestJS engine (namespace owner), so pickup filtering is correct — but a local hybrid setup typically has **no local Python worker** consuming the local Redis group, so a run with `processing.run = true` would stall at remote dispatch. Namespace fixes the *theft*, not the *absence* of a local Python worker. Ingestion-only runs (the immediate case) are unaffected.
- **Mixed namespace + lease.** Lease/heartbeat semantics are unchanged; namespace is an additional, earlier filter. A run already `running` under one namespace is never visible to another namespace's recovery, so the two mechanisms compose without interaction.

## Testing

- core: unit test each poll path filters by namespace (a `default` worker ignores a `davi-local` pending run and vice-versa); a child inherits its parent's namespace; `undefined` namespace = no filter (back-compat).
- store-mikro-orm: query tests for the four list methods with/without namespace; `ensureSchema` adds the column+index additively on an existing table.
- Integration: two engines on one store with different namespaces — each only executes its own pending/incomplete/due/timed-out runs; the dashboard `listRuns` still returns both.
