# Durable Tenants & the Hosted Control Plane

**Status:** Design (for review)
**Date:** 2026-06-30
**Builds on:** [`2026-06-26-durable-namespace-design.md`](./2026-06-26-durable-namespace-design.md)

## Summary

Today `@dudousxd/nestjs-durable` ships as one thing: an app imports `DurableModule` and gets
**both** a control plane (engine + state store + recovery + dispatch, the thing that owns the
database) **and** a worker (the `@Workflow`/`@Step` handlers that execute). `namespace`
(shipped 2026-06-26) lets several of these full engines share one database while each only acts on
its own partition.

This design separates the two halves and introduces a second, stronger topology — the **hosted
control plane** — where one deployment owns the database and other apps connect to it as
**tenants** that run *only* workers, over the transport, **never touching the database**.

The two topologies coexist; they are different points on a single axis — **who owns the store**:

| | **Namespace** (shipped) | **Tenant / hosted control plane** (this design) |
|---|---|---|
| Who sees the DB | every app (each runs a full engine) | **only the control plane** |
| How an app participates | runs the whole engine, filters by its `namespace` | runs **only workers**, connects via the **transport protocol**, zero DB |
| App-facing concept | `namespace` (the app filters its own EM) | `tenant` (declared identity; namespace is internal plumbing) |
| Failure mode | forget to set `namespace` → unscoped EM → **steals everyone's runs** | impossible — a tenant has no DB connection to misuse |
| Good for | an app that wants standalone durability but shares infra | small apps that "just code the workers" against a shared platform |

## Vocabulary (the reconciliation)

`namespace` and `tenant` are **not** synonyms; they are the same partition seen from two layers:

- **`tenant`** — the *app-facing identity*. An app declares "I am tenant `X`." In the hosted model
  this is the only word an app ever uses.
- **`namespace`** — the control plane's *internal partition key* (the column on a run, the queue
  prefix). It stays as plumbing.

In the **namespace topology** the app holds an `EntityManager` and filters itself, so it deals with
`namespace` directly — which is why the two looked identical. In the **tenant topology** the app has
no EM; it sends its `tenant` over the protocol and the control plane maps `tenant → namespace`
internally. Moving "from namespace to tenant" is therefore **a change of topology, not a rename**:
the app-facing concept shifts from *"filter your own EM"* to *"declare who you are; the control
plane does the rest"*, and the consequence is that **local apps stop touching the dev database**.

## The proof it already works

The flip stack already runs the hosted topology across a language boundary:

- **flip-nestjs** is the control plane: its `WorkflowEngine` owns the `durable_*` tables, runs
  recovery/timers, and dispatches workflow turns.
- **flip-python** is a tenant worker: a Redis-only remote executor that consumes turns/steps off the
  transport, executes, and returns decisions/results — and **never reads or writes the store**. The
  `processing` workflow's code lives entirely in the Python worker; flip-nestjs's engine drives it
  without ever holding that code.

So the control-plane↔worker split is live in production. What's missing is making it a *first-class,
generic* capability instead of a bespoke `engine.remote('processing', …)` wiring.

## The three pieces

### 1. Module split

`DurableModule` is decomposed into two importable modules:

- **`DurableControlPlaneModule`** — engine, state store (DB), recovery, timers, dispatch, dashboard.
  **Owns the database.** Only the control-plane deployment imports it (e.g. flip-nestjs-dev).
- **`DurableWorkerModule`** — transport connection + the registered `@Workflow`/`@Step` handlers.
  **No state store, no DB credentials.** Connects to a control plane purely over the transport. Any
  app imports only this.

A deployment may import both (flip-nestjs is the control plane **and** runs its own workflows
in-process — see "flip's dual role"). A pure tenant app imports only `DurableWorkerModule`.
`DurableModule` is kept as a thin alias of "both" for back-compat.

### 2. Generic routing: `(namespace, workflow) → worker group`

Today the engine must be told about each remote workflow (`engine.remote('processing', { group })`).
For arbitrary tenants the control plane must route a pending run — `(namespace=X, workflow=W)` — to
the right worker group **without importing W's code**. The mechanism: the worker self-registers its
group on the (namespace-prefixed) transport, and the engine routes by convention rather than by a
hard-coded registration. This generalizes the existing `registerRemote`/`engine.remote` path.

### 3. Start-run over the protocol

A pure tenant worker has **no DB**, so it cannot `createRun` directly. Starting a workflow must go
through the control plane over the transport: the worker SDK sends a `start-run` message
(`{ tenant, workflow, input }`); the control plane validates, **stamps the run with the tenant's
namespace**, and inserts it into the store. This is the surface that makes a run "appear" in the
control plane — the app never touches the database, it only declares who it is. (In flip today this
is invisible because flip-nestjs itself creates the pipeline runs; an autonomous tenant needs it.)

## Data-access scoping (reads, not just the engine poll)

`namespace` (2026-06-26) filters the engine's **poll paths** (`runPending`/`recoverIncomplete`/
`resumeDueTimers`/`sweepTimeouts`). But an arbitrary read — e.g. flip's `search-pipeline-runs`
controller building a raw `QueryBuilder<WorkflowRunEntity>` — **bypasses that** and sees every
namespace. That is why `dev.goflip.ai/ctrl/pipeline-runs` currently shows `davi-local` runs.

**Rule:** scoping must be uniform across *all* store access, not per-controller. In the
namespace/shared-DB topology this is a **MikroORM global filter** registered by the control plane
from its configured `namespace`, `default: true` on the durable entities, so *every* query
(including raw `@ApplyFilter` query builders) auto-includes `namespace = X`.

**Seeing all namespaces = the absence of a configured namespace.** Only the control plane has an EM,
and a control plane with no `namespace` set is, by definition, the operator — it sees every tenant.
We deliberately do **not** add a separate `controlPlane: true` flag: the original steal-bug footgun
("forgot to set namespace → unscoped → stole everyone's runs") was a property of the
**shared-DB topology**, where apps hold EMs. In the **tenant topology the footgun is gone by
construction** — a tenant has no database connection to misuse, so "unset namespace = see all" is
safe because the only holder of an EM is the operator.

## flip's dual role

flip-nestjs is simultaneously the **control plane** and the **`default` tenant** (it runs the
`pipeline` workflow). Consequences:

- `/ctrl/pipeline-runs` (admin) is legitimately the **operator view** — seeing all tenants is
  correct; the `namespace`/`tenant` column + filter (added 2026-06-30) is what distinguishes them
  and lets the operator find/manage another tenant's runs (e.g. cancel a stuck `davi-local` run).
- A `tenant = default` filter is "show only flip's own runs." Whether that filter defaults on (clean
  app view) or off (full operator view) is a product choice for that screen, not a library concern.

## The transport as the tenant boundary

The worker↔control-plane "protocol" is the existing transport (BullMQ/Redis): the control plane
enqueues turns/step-calls; the worker consumes and returns decisions/results. A tenant therefore
needs transport credentials + the namespace prefix, but **not** store credentials. This is what
makes "local apps connect to the dev control plane as a tenant" work: a developer's local stack
(or any app) points its `DurableWorkerModule` at the shared transport with `tenant = davi-local`,
runs its workers, and its runs appear in the control plane under that tenant — while it never opens a
connection to the dev database.

## Open questions / decisions

1. **Tenant id allocation** — free string the app declares (like `davi-local` today), or a light
   registry/convention (e.g. `tenant = appName`) to guarantee uniqueness? Free string is fine for
   internal/trusted use; a registry only matters for collision-safety or external tenants.
2. **Trust boundary** — `tenant`/`namespace` is a **soft** boundary in the shared-transport model
   (anyone with the transport creds can publish as any tenant). Acceptable for internal goflip apps;
   an untrusted/external tenant would need per-tenant auth on the start-run + dispatch surface. This
   design assumes **internal, trusted** tenants; external multi-tenancy is out of scope.
3. **Naming of the internal column** — keep `namespace` as the internal partition key (cosmetic), or
   rename to `tenant` throughout. Leaning: keep `namespace` internal, expose `tenant` app-facing.
4. **Control-plane blast radius / scale** — one control plane is one SPOF and one scaling unit for
   every tenant's coordination (the shared store poll + dispatch throughput). The adaptive-concurrency
   and global-cap (`registerQueue`) work matters here; this is "internal platform," not unbounded
   tenancy.

## Non-goals

- External/untrusted multi-tenancy (auth per tenant).
- Replacing the namespace/shared-DB topology — it stays as the lightweight "I want standalone
  durability but share infra" option.
- A new wire protocol — the transport (Redis/BullMQ) is the protocol.
