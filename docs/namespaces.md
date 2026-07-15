# Namespaces — partitioning a shared store

A **namespace** scopes which runs an engine **owns and recovers** from a store. It's the answer to:
*"multiple engines share one database — how do I stop engine A from recovering and re-driving engine
B's runs?"* The canonical case is a developer running locally against the **shared dev database**
without their runs colliding with the dev cluster's.

## What it does

Set `namespace` on the engine:

```ts
new WorkflowEngine({ store, transport, namespace: 'dev-alice' }); // default: 'default'
```

```ts
// NestJS
DurableModule.forRoot({ store, transport, namespace: process.env.DURABLE_NAMESPACE ?? 'default' });
```

- Every run an engine **starts** is stamped with that engine's namespace (a column on the run).
- An engine only **recovers / polls / times-out** runs in its **own** namespace. A run from another
  namespace is invisible to its recovery loop (an attempt to resume a foreign run raises
  `NamespaceMismatch`).

So two engines on the **same store** with different namespaces never steal each other's work. With
the default `'default'` everywhere, behaviour is byte-identical to a single-pool deployment — you only
opt in when you actually share a store.

## The two axes of isolation (important)

Namespace partitions the **store**. It does **NOT** partition the **transport**. The BullMQ queue
names are `<prefix>-tasks-<group>` — there is no namespace in them. So if two namespaced engines share
the **same Redis + prefix + group**, a task dispatched by one can be consumed by the other's worker.

| Axis | What it isolates | How |
|------|------------------|-----|
| **Store** (the shared DB) | which engine **recovers / owns** a run | **`namespace`** |
| **Transport** (the queues) | where tasks land & which worker **consumes** them | a **separate Redis** (or a distinct `prefix`) |

To fully isolate two setups on a shared store, you need **both**: a distinct `namespace` *and* a
distinct Redis/prefix. Namespace alone leaves the queues shared.

**Per-run tenant ROUTING is a third, orthogonal mechanism** — and the only tenant encoding on the
wire: work for a run in namespace `X` dispatches to `@X`-suffixed group tokens
(`durable-tasks-processing@dev-alice`, see `tenantGroup`) on the transport's own prefix, and tenant
workers (the Python SDK, the TS `role: 'tenant'` worker) subscribe those suffixed queues. That is
how one control plane routes each tenant's runs to that tenant's worker pool over ONE shared
keyspace. The engine's namespace never re-scopes the transport prefix — a scoped local control
plane therefore reaches the same tenant workers the deployed global operator would, with no extra
configuration.

## Local development against the shared dev store

The pattern that motivates all of this:

> Everyone develops against the **shared dev database** (real data), but each developer's durable runs
> must execute **only on their own machine** — never picked up by the dev cluster, and never leaking a
> task into the dev cluster's workers.

Recipe:

| Piece | Value | Why |
|-------|-------|-----|
| Store | **shared dev DB** | real data; `namespace = 'dev-<you>'` keeps your runs yours |
| Namespace | **`dev-<you>`** (unique per developer) | the dev cluster (`'default'`) never recovers your runs |
| Redis | **local** (or a unique `prefix`) | your tasks never reach a dev worker, and vice-versa |

With that, a run you start locally is stamped `dev-<you>`, dispatched to your **local** Redis, consumed
by your **local** worker, and checkpointed back to the shared DB under your namespace — fully isolated,
while still reading real dev data. The dev cluster's recovery poller filters on `'default'`, so it
never touches a `dev-<you>` run even though it's sitting in the same database.

> Give each developer a **unique** namespace (`dev-alice`, `dev-bob`). Two developers sharing both the
> dev DB *and* the same namespace would steal each other's runs.

## Caveat: raw entity creation

The store stamps the namespace on the run for you. If you bypass the store and create a run entity
directly (e.g. a raw `em.create(...)` in a migration or a custom adapter), you must set the namespace
field yourself — an unstamped run defaults to `'default'` and would be visible to the default pool.
