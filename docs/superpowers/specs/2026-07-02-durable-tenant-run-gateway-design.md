# Durable Tenant Run Gateway — Design

**Status:** approved (brainstorming) — 2026-07-02
**Goal:** let a store-less TENANT worker read and control its OWN runs (which live in the control plane's store) over the shared transport, so a tenant app can surface run status/detail to its users, live-tail a run, and request cancel/retry — WITHOUT the tenant holding a store and WITHOUT any HTTP coupling to the control plane.

## Background

The durable tenant topology (already shipped): ONE control-plane/operator holds the store and drives everything (`namespace: undefined` = sees/drives all tenants — retry, cancel, orphan-checks, timers); other apps run `DurableWorkerModule` with a `tenant`, hold no store, and are pure workers. `engine.start` is already uniform: a tenant publishes a `StartRunMessage` on the shared `durable-start-run` queue and the operator turns it into a run; the run's task routes back to `<workflow>@<tenant>`. All tenant↔operator communication rides the **shared Redis/BullMQ transport** — never HTTP.

This design adds the READ + CONTROL + STREAM half of that story.

## Non-goals (YAGNI)

- **No full dashboard SPA / ops surface on a tenant.** The tenant gets run-detail, list, control, and live-stream — the flip `DurableRunController` surface + `listRuns`. It does NOT proxy `metrics`, `bulk`, `workerHealth`, `update`, `signal`/`deliverWebhook`, `getEvent`. Those stay control-plane-only (the operator's dashboard).
- **No direct durable-store DB read from the tenant.** Even where a tenant happens to share the physical DB (the dev-local case), the tenant does NOT open a read-only `StateStore` on `durable_*`. The proxy rides the transport so the design generalizes to any tenant (including one with no DB access) and keeps the "tenant holds no store, reaches the operator only via the transport" invariant intact.
- **No new control semantics.** Control verbs (`cancel`/`retry`/`continue`/`retryWithInput`) still EXECUTE on the operator via the existing `engine.*` methods. The tenant only *requests*; the operator owns the store write + the cancel broadcast. This preserves "the control plane owns cancel/retry/orphans."

## Architecture

A bounded **`RunGateway`** port that both topologies satisfy, backed by two new transport primitives (each mirrors the existing `dispatchStartRun`/`onStartRun` + `-control`/`-heartbeat` pub/sub scaffolding — no rewrite):

### Primitive 1 — request/reply (`RunRequest` → `RunReply`)

- **Request leg (tenant → operator):** a new one-way queue channel `dispatchRunRequest(msg)` / `onRunRequest(handler)`, queue name `<effectivePrefix>-run-request` — a verbatim copy of the `dispatchStartRun`/`onStartRun` pattern.
- **Reply leg (operator → tenant):** a new pub/sub channel `<effectivePrefix>-run-reply`. The operator publishes the reply; every tenant subscribes and filters client-side by `requestId` (the exact `msg.from` self-filter idiom `onControl`/`onHeartbeat` already use). A shared pub/sub channel is chosen over a one-shot per-request queue: no per-request queue create/teardown, and it matches the codebase's existing pub/sub idiom.

Message contracts (new, in `packages/core/src/interfaces.ts`):

```ts
type RunRequestKind =
  | { kind: 'getRunDetail'; runId: string }
  | { kind: 'listRuns'; query: RunQuery }
  | { kind: 'cancel'; runId: string }
  | { kind: 'retry'; runId: string }
  | { kind: 'continue'; runId: string }
  | { kind: 'retryWithInput'; runId: string; input: unknown };

interface RunRequest {
  requestId: string;   // correlation id, minted by the tenant
  tenant: string;      // the requesting tenant (maps to the run namespace scope)
  body: RunRequestKind;
}

interface RunReply {
  requestId: string;
  result:
    | { ok: true; data: unknown }        // shape depends on the request kind
    | { ok: false; error: { message: string; code?: string } };
}
```

### Primitive 2 — tenant event subscription (for SSE live-tail)

When the operator emits a lifecycle event (`run.completed` / `run.failed` / `run.suspended` / step progress) for a run that carries a `namespace` (i.e. a tenant's run), it ALSO publishes that event to a per-tenant pub/sub subject `<effectivePrefix>-tenant-events-<tenant>`. The tenant subscribes to its OWN subject only, so it can never observe another tenant's runs. This is additive to the existing `-control` event broadcast (which stays operator-internal).

## Components

Each is a small unit with one responsibility and a clear interface.

### `RunGateway` (the port) — `packages/core/src/run-gateway.ts` (new)

```ts
interface RunDetail {
  run: WorkflowRun;
  checkpoints: StepCheckpoint[];
  children: WorkflowRun[];
}

interface RunGateway {
  getRunDetail(runId: string): Promise<RunDetail | null>;
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
  cancel(runId: string): Promise<void>;
  retry(runId: string): Promise<void>;
  continue(runId: string): Promise<void>;
  retryWithInput(runId: string, input: unknown): Promise<void>;
  /** Live lifecycle events for one run; returns an unsubscribe fn. */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void;
}
```

### Operator side — `RunRequestResponder` — `packages/nestjs/src` (new; wired by `DurableModule`)

Wraps the operator's own store-backed `RunGateway` (the same `StoreRunGateway` bound for local control-plane use — so the store/engine calls live in ONE place, never duplicated) and applies tenant-scoping around it. Consumes `onRunRequest`. For each request:
1. **Scope to `msg.tenant`** (load-bearing security):
   - `getRunDetail` / control verbs: load the run; if `run.namespace !== msg.tenant`, reply `{ ok:false, error:{ code:'cross-tenant' } }` — never act.
   - `listRuns`: force `query.namespace = msg.tenant` (ignore any namespace the client sent).
2. Delegate by kind to the wrapped `StoreRunGateway` (which does the store/engine calls: `getRunDetail` → `store.getRun` + `store.listCheckpoints` + `engine.getRunChildren`; `listRuns` → `store.listRuns`; `cancel`/`retry`/`continue`/`retryWithInput` → `engine.*`).
3. Publish a `RunReply` (serialising any thrown error into `{ ok:false, error }`).

Plus an **event re-publisher**: hooks the engine's event emission and, for any event whose run has a namespace, publishes it on `<prefix>-tenant-events-<namespace>`.

### Tenant side — `ProxyRunGateway` (implements `RunGateway`) — `packages/nestjs/src` (new; wired by `DurableWorkerModule`)

- Each method: mint a `requestId`, `dispatchRunRequest`, await the correlated `RunReply` with a **timeout** (config, default 10s), resolve `data` or re-throw the operator's error. A single subscription to `-run-reply` fans replies to pending requests by `requestId`.
- `subscribe(runId, onEvent)`: subscribe to `<prefix>-tenant-events-<tenant>`, filter to `runId`, invoke `onEvent`; return an unsubscribe fn.

### Wiring

- `DurableWorkerModule` provides `RunGateway` → `ProxyRunGateway` (tenant), exported.
- `DurableModule` provides `RunGateway` → `StoreRunGateway` (operator; a thin adapter over `store` + `engine`) AND starts the `RunRequestResponder` (which wraps that same `StoreRunGateway`) + event re-publisher.
- Both provide under the same `RunGateway` token so consumers are topology-agnostic.

### flip adoption

`flip-nestjs`'s `DurableRunController` (currently injects `DashboardService`) is refactored to inject the `RunGateway` port for its six methods (`getRunDetail`, `streamRun`→`subscribe`, `retry`, `cancel`, `continue`, `retryWithInput`). Control-plane flip binds `RunGateway` to a `DashboardService`-backed adapter (or the lib's store-backed gateway); tenant flip binds the lib's `ProxyRunGateway`. The dashboard SPA (`DurableDashboardModule`) stays mounted only on the control plane.

## Data flows

- **getRunDetail (tenant):** controller → `ProxyRunGateway.getRunDetail(id)` → `dispatchRunRequest({requestId, tenant, body:{kind:'getRunDetail', runId:id}})` → operator `RunRequestResponder` verifies `run.namespace === tenant`, reads store, replies on `-run-reply` → proxy resolves `RunDetail`.
- **cancel (tenant):** same round-trip; operator calls `engine.cancel(id)` (real store write + control-plane cancel broadcast to abort the running worker), replies `{ok:true}`.
- **streamRun / SSE (tenant):** controller opens SSE → `ProxyRunGateway.subscribe(id, cb)` subscribes to `-tenant-events-<tenant>`; operator emits `run.*` for that run → re-published on the tenant subject → proxy filters by `runId` → SSE frame. Unsubscribe on connection close.

## Error handling

- **Timeout:** operator silent past the window → proxy rejects with a clear `control plane did not respond to <kind> within <ms>ms`.
- **Operator errors** (`run not found`, `cross-tenant`, engine failure): serialised into `RunReply.result.error` and re-thrown client-side with the same message/code, so the controller maps them to HTTP status as it does today.
- **Reply after timeout:** dropped (the pending entry is already gone); harmless.

## Security / trust boundary

The operator scopes EVERY request to `msg.tenant` (namespace match on reads/control, forced namespace on list), so a tenant can never read or act on another tenant's run even knowing its `runId`. The trust boundary is **Redis access** — a tenant asserts its own `tenant` name, exactly as it already does for start-run and task routing; anyone with the shared Redis credentials is a trusted tenant. This matches the existing model and is appropriate for the dev-local scenario. (A future hardened multi-tenant deployment would authenticate the tenant claim at the transport, out of scope here.)

## Testing strategy

- **Unit:** responder cross-tenant denial (getRunDetail/cancel on a foreign run → `{ok:false, cross-tenant}`, engine NOT called); `listRuns` forces namespace; request/reply round-trip over a fake transport; `ProxyRunGateway` timeout; reply correlation by `requestId`; tenant-event scope filter (only own subject/runId).
- **Integration (real Redis, alongside existing e2e):** a tenant `ProxyRunGateway` ↔ operator round-trip for `getRunDetail`, `cancel` (verify the run actually cancels), and a live `subscribe` stream receiving a settle event.

## Sequencing

Bigger than the uniform-start increment; several SDD tasks, and it needs **its own beta** before flip adopts it. Build order:
1. Core message contracts + `RunGateway` interface + transport primitive signatures (`dispatchRunRequest`/`onRunRequest`, `-run-reply` pub/sub, `-tenant-events-<tenant>` pub/sub).
2. `BullMQTransport` implementation of the three channels.
3. Operator `RunRequestResponder` + event re-publisher + store-backed gateway; wired by `DurableModule`.
4. Tenant `ProxyRunGateway`; wired by `DurableWorkerModule`.
5. Integration test (real Redis) tenant ↔ operator.
6. Changeset + beta (gated on Davi's OK).
7. flip adoption: `DurableRunController` → `RunGateway` port; tenant vs control-plane binding (separate, gated on the beta + a dev deploy).
