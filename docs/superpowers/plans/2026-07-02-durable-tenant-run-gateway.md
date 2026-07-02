# Durable Tenant Run Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a store-less TENANT worker read (`getRunDetail`/`listRuns`), control (`cancel`/`retry`/`continue`/`retryWithInput`), and live-stream its OWN runs — which live in the control plane's store — over the shared transport, with no store and no HTTP.

**Architecture:** A bounded `RunGateway` port both topologies satisfy. The control plane binds a store-backed gateway (reuses `DashboardService`) and runs a `RunRequestResponder` + event re-publisher; a tenant binds a `ProxyRunGateway` that round-trips `RunRequest`/`RunReply` over two new transport channels (a request queue + a reply pub/sub) and subscribes to a per-tenant event channel for streaming. Every operator response is scoped to the requesting tenant's namespace.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), pnpm+turbo monorepo, vitest, changesets, BullMQ/Redis transport, NestJS 11.

**Spec:** `docs/superpowers/specs/2026-07-02-durable-tenant-run-gateway-design.md`

## Global Constraints

- **Transport-only, no HTTP:** everything rides the shared Redis/BullMQ transport, mirroring the existing `dispatchStartRun`/`onStartRun` (queue) and `-control`/`-heartbeat` (pub/sub) patterns.
- **Option-B scoping / security:** the operator scopes EVERY request to `msg.tenant` — reads/control verify `run.namespace === tenant` (else reply `{ok:false, error:{code:'cross-tenant'}}`, engine NOT called); `listRuns` forces `query.namespace = tenant`. A tenant can never touch another tenant's run. Trust boundary = Redis access (documented).
- **Reuse, don't duplicate:** the control-plane gateway IS `DashboardService` (already implements the six methods). The `RunRequestResponder` wraps a `RunGateway`, so store/engine calls live in ONE place.
- **Wire serialization:** reply payloads cross BullMQ serialized **the same way existing job payloads already are** (match how `dispatch(RemoteTask)`/`onResult(StepResult)` encode their `input`/`output` in `BullMQTransport` — do NOT invent a new codec). `Date` fields surfacing as ISO strings over the wire is acceptable: the sole consumer (a controller) re-serializes to HTTP JSON anyway.
- **No `as`/`any`/`unknown`/`never`** in new code, except: (a) the canonical opaque-payload `unknown` that mirrors a faced signature (e.g. `retryWithInput(runId, input: unknown)`), and (b) decoding a wire reply — use a discriminated union + a type guard / narrowing on `result.ok`, never a blind cast.
- **Fixed exact versions; no Co-Authored-By; function declarations; match surrounding style.**
- **TDD:** failing test first each task. Run the suite from repo ROOT via `pnpm test`; typecheck via `pnpm -r typecheck`; the biome gate is `pnpm biome ci .`. (There is NO per-package `test` script — do not use `pnpm --filter <pkg> test`.)
- **Libs commit locally on `main`; DO NOT push/publish** without confirmation. Beta + flip adoption are gated appendices.

---

## File Structure

- `packages/core/src/interfaces.ts` — add `RunRequest`/`RunReply`/`RunRequestKind`/`RunReplyResult` message types + six optional `Transport` methods (`dispatchRunRequest`/`onRunRequest`, `publishRunReply`/`onRunReply`, `publishTenantEvent`/`onTenantEvent`).
- `packages/core/src/run-gateway.ts` — **new**: the `RunGateway` interface + `RunDetail` type (the port).
- `packages/core/src/index.ts` — export the above.
- `packages/transport-bullmq/src/bullmq-transport.ts` — implement the six channels (one request queue + two pub/sub channels).
- `packages/nestjs/src/store-run-gateway.ts` — **new**: operator-side `StoreRunGateway` (thin adapter over `store`+`engine`; structurally equals `DashboardService`'s six methods).
- `packages/nestjs/src/run-request-responder.ts` — **new**: operator consumer that wraps a `RunGateway`, tenant-scopes, replies; plus the event re-publisher.
- `packages/nestjs/src/proxy-run-gateway.ts` — **new**: tenant-side `RunGateway` over request/reply + tenant-events.
- `packages/nestjs/src/durable.module.ts` — wire `RunGateway`→`StoreRunGateway`, start the responder + re-publisher (operator).
- `packages/nestjs/src/durable-worker.module.ts` — wire `RunGateway`→`ProxyRunGateway` (tenant).
- `packages/nestjs/src/index.ts` — export `RunGateway` token, `ProxyRunGateway`, `StoreRunGateway`.
- `.changeset/tenant-run-gateway.md`.

---

## Task 1: Core contracts — messages, `RunGateway` port, transport signatures

**Files:**
- Modify: `packages/core/src/interfaces.ts` (add message types after `StartRunMessage` ~471; add six optional methods to `Transport` interface ~733-783)
- Create: `packages/core/src/run-gateway.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './run-gateway';`)
- Test: `packages/core/src/run-gateway.spec.ts` (a compile-level + shape test)

**Interfaces:**
- Consumes: `RunQuery`, `WorkflowRun`, `StepCheckpoint`, `EngineEvent`, `RunResult` (all already in `interfaces.ts`).
- Produces: the types below — every later task imports them.

- [ ] **Step 1: Write the failing test**

`packages/core/src/run-gateway.spec.ts` — a shape/type test that fails to compile until the types exist:

```ts
import { describe, expect, it } from 'vitest';
import type { RunGateway, RunDetail } from './run-gateway';
import type { RunRequest, RunReply } from './interfaces';

describe('RunGateway contracts', () => {
  it('RunRequest is a discriminated, tenant-scoped envelope', () => {
    const req: RunRequest = {
      requestId: 'r1',
      tenant: 'acme',
      body: { kind: 'getRunDetail', runId: 'run-1' },
    };
    expect(req.body.kind).toBe('getRunDetail');
  });

  it('RunReply discriminates ok vs error', () => {
    const ok: RunReply = { requestId: 'r1', result: { ok: true, data: null } };
    const err: RunReply = {
      requestId: 'r1',
      result: { ok: false, error: { message: 'not found', code: 'not-found' } },
    };
    expect(ok.result.ok).toBe(true);
    expect(err.result.ok).toBe(false);
  });

  it('RunGateway exposes the six run operations + subscribe', () => {
    // Type-level assertion: a value of this shape must satisfy RunGateway.
    const g: Pick<RunGateway, 'getRunDetail'> = {
      getRunDetail: async (_id: string): Promise<RunDetail | null> => null,
    };
    expect(typeof g.getRunDetail).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- run-gateway`
Expected: FAIL — cannot find module `./run-gateway`, and `RunRequest`/`RunReply` not exported from `./interfaces`.

- [ ] **Step 3: Add message types to `interfaces.ts`**

Immediately after the `StartRunMessage` interface (~line 471), add:

```ts
/**
 * A tenant worker → control plane read/control request over the shared transport. Enqueued on
 * `<effectivePrefix>-run-request`; the control plane's `onRunRequest` consumer answers it, scoped to
 * `tenant`, and publishes a {@link RunReply} on `<effectivePrefix>-run-reply` correlated by `requestId`.
 */
export interface RunRequest {
  /** Correlation id minted by the tenant; the matching {@link RunReply} carries it back. */
  requestId: string;
  /** The requesting tenant — the operator scopes the run's namespace to this. */
  tenant: string;
  body: RunRequestKind;
}

/** The discriminated verb + args of a {@link RunRequest}. Mirrors the tenant-facing `RunGateway`. */
export type RunRequestKind =
  | { kind: 'getRunDetail'; runId: string }
  | { kind: 'listRuns'; query: RunQuery }
  | { kind: 'cancel'; runId: string }
  | { kind: 'retry'; runId: string }
  | { kind: 'continue'; runId: string }
  | { kind: 'retryWithInput'; runId: string; input: unknown };

/** The control plane's answer to a {@link RunRequest}, correlated by `requestId`. */
export interface RunReply {
  requestId: string;
  result: RunReplyResult;
}

/** Success carries the verb's payload (JSON-serialised); failure carries a re-throwable error. */
export type RunReplyResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { message: string; code?: string } };

/** A lifecycle event re-published to a single tenant's channel (`<effectivePrefix>-tenant-events-<tenant>`)
 *  so a store-less tenant can live-tail ITS OWN runs. Scoped by the run's namespace at publish time. */
export interface TenantEvent {
  tenant: string;
  event: EngineEvent;
}
```

- [ ] **Step 4: Add the six optional methods to the `Transport` interface**

Inside `Transport` (before the closing brace at ~783), add:

```ts
  /**
   * Tenant worker → control plane: publish a {@link RunRequest} (read/control) on
   * `<effectivePrefix>-run-request`. Optional — only broker transports carry it.
   */
  dispatchRunRequest?(msg: RunRequest): Promise<void>;
  /** control plane ← tenant worker: consume {@link RunRequest}s. Pair with {@link dispatchRunRequest}. */
  onRunRequest?(handler: (msg: RunRequest) => Promise<void>): void;
  /** control plane → tenant worker: publish a correlated {@link RunReply} on `<effectivePrefix>-run-reply`
   *  (pub/sub; every tenant subscribes and filters by `requestId`). */
  publishRunReply?(reply: RunReply): Promise<void>;
  /** tenant worker ← control plane: consume {@link RunReply}s (filter by `requestId` client-side). */
  onRunReply?(handler: (reply: RunReply) => void): void;
  /** control plane → tenant worker: re-publish a lifecycle {@link TenantEvent} on the run's per-tenant
   *  channel `<effectivePrefix>-tenant-events-<tenant>`. */
  publishTenantEvent?(evt: TenantEvent): Promise<void>;
  /** tenant worker ← control plane: subscribe to THIS tenant's event channel. Returns an unsubscribe fn. */
  onTenantEvent?(tenant: string, handler: (evt: TenantEvent) => void): () => void;
```

- [ ] **Step 5: Create the `RunGateway` port**

`packages/core/src/run-gateway.ts`:

```ts
import type { EngineEvent } from './interfaces';
import type { RunQuery, RunResult, StepCheckpoint, WorkflowRun } from './interfaces';

/** A run + its timeline + child ids — the detail view. Mirrors the dashboard's `RunDetail`. */
export interface RunDetail {
  run: WorkflowRun;
  /** Steps in execution order (local + remote). */
  timeline: StepCheckpoint[];
  /** Ids of runs this run spawned (parent→children tree). */
  children: string[];
}

/**
 * The bounded read/control/stream surface a consumer (e.g. a controller) needs, satisfied by BOTH
 * topologies: the control plane binds a store-backed impl (reuses `DashboardService`); a tenant binds
 * a `ProxyRunGateway` that round-trips over the transport. Deliberately smaller than the full dashboard
 * (no metrics/bulk/workerHealth/update/signal) — those stay control-plane-only.
 */
export interface RunGateway {
  getRunDetail(runId: string): Promise<RunDetail | null>;
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
  cancel(runId: string): Promise<RunResult | null>;
  retry(runId: string): Promise<RunResult | null>;
  continue(runId: string): Promise<RunResult | null>;
  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null>;
  /** Live lifecycle events for one run; returns an unsubscribe fn. Framework-agnostic (no rxjs). */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void;
}
```

(Confirm `RunResult`, `StepCheckpoint`, `EngineEvent`, `RunQuery`, `WorkflowRun` are all exported from `interfaces.ts` — they are, per the dashboard's imports. Import `EngineEvent` from `./interfaces` too; merge the two import lines.)

- [ ] **Step 6: Export from the barrel**

In `packages/core/src/index.ts` add `export * from './run-gateway';` (near the other `export *` lines).

- [ ] **Step 7: Run test + typecheck**

Run: `pnpm test -- run-gateway` then `pnpm --filter @dudousxd/nestjs-durable-core typecheck`
Expected: PASS + clean.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/interfaces.ts packages/core/src/run-gateway.ts packages/core/src/index.ts packages/core/src/run-gateway.spec.ts
git commit -m "feat(core): RunGateway port + RunRequest/RunReply/TenantEvent transport contracts"
```

---

## Task 2: `BullMQTransport` — request queue + reply/tenant-event pub/sub

**Files:**
- Modify: `packages/transport-bullmq/src/bullmq-transport.ts`
- Test: `packages/transport-bullmq/src/bullmq-transport.spec.ts` (or the existing transport spec)

**Interfaces:**
- Consumes: `RunRequest`, `RunReply`, `TenantEvent` (Task 1).
- Produces: `BullMQTransport` now implements `dispatchRunRequest`/`onRunRequest` (queue), `publishRunReply`/`onRunReply` (pub/sub), `publishTenantEvent`/`onTenantEvent` (pub/sub).

**Pattern to copy (read these first):** the request-queue pair is a verbatim analog of `dispatchStartRun`/`onStartRun` + `#startRunName()` (`bullmq-transport.ts:493-510`, name builder near :196). The two pub/sub pairs are analogs of `publishControl`/`onControl` + `controlChannel()` (`:459-491`) — they use `this.redis()` (the duplicated ioredis client, :469-473) for `PUBLISH`/`SUBSCRIBE`. Serialise payloads exactly as the existing pairs do.

- [ ] **Step 1: Write the failing test**

Add to the transport spec (use the file's existing fake/real-redis harness — match how the `startRun`/`control` tests are written). Sketch:

```ts
it('round-trips a RunRequest on the request queue', async () => {
  const seen: RunRequest[] = [];
  transport.onRunRequest(async (m) => { seen.push(m); });
  await transport.dispatchRunRequest({ requestId: 'q1', tenant: 'acme', body: { kind: 'cancel', runId: 'r1' } });
  await waitUntil(() => seen.length === 1); // reuse the file's polling helper
  expect(seen[0]).toMatchObject({ requestId: 'q1', tenant: 'acme', body: { kind: 'cancel', runId: 'r1' } });
});

it('fans a RunReply to onRunReply subscribers', async () => {
  const seen: RunReply[] = [];
  transport.onRunReply((r) => seen.push(r));
  await transport.publishRunReply({ requestId: 'q1', result: { ok: true, data: null } });
  await waitUntil(() => seen.length === 1);
  expect(seen[0].requestId).toBe('q1');
});

it('delivers a TenantEvent only to that tenant\'s channel', async () => {
  const acme: TenantEvent[] = [];
  const off = transport.onTenantEvent('acme', (e) => acme.push(e));
  await transport.publishTenantEvent({ tenant: 'beta', event: makeEvent('run-x') });
  await transport.publishTenantEvent({ tenant: 'acme', event: makeEvent('run-1') });
  await waitUntil(() => acme.length === 1);
  expect(acme).toHaveLength(1); // NOT the beta event
  off();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- bullmq-transport`
Expected: FAIL — methods not implemented.

- [ ] **Step 3: Implement the request queue**

Add a `#runRequestName()` builder (mirror `#startRunName()`), a `dispatchRunRequest` that `queue(...).add('runRequest', msg, {removeOnComplete:true, removeOnFail:true})`, and `onRunRequest` that starts a `Worker` on that queue calling the handler — copy the `dispatchStartRun`/`onStartRun` bodies at `bullmq-transport.ts:493-510` and rename.

- [ ] **Step 4: Implement the two pub/sub channels**

Add `runReplyChannel()` and `tenantEventChannel(tenant)` = `` `${this.#effectivePrefix()}-run-reply` `` and `` `${this.#effectivePrefix()}-tenant-events-${tenant}` ``. Implement `publishRunReply`/`onRunReply` and `publishTenantEvent`/`onTenantEvent` copying `publishControl`/`onControl` (`:459-491`): a dedicated `this.redis()` subscriber connection, `subscribe(channel)`, JSON-parse the message, invoke the handler. `onTenantEvent` subscribes to the tenant-specific channel and returns an unsubscribe fn (`unsubscribe(channel)` + remove the listener). Track new subscriber connections so `close()` tears them down (match how the control/heartbeat subscriber is closed).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- bullmq-transport`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/transport-bullmq/src/bullmq-transport.ts packages/transport-bullmq/src/bullmq-transport.spec.ts
git commit -m "feat(transport-bullmq): run-request queue + run-reply and tenant-event pub/sub channels"
```

---

## Task 3: Operator — `StoreRunGateway`, `RunRequestResponder`, event re-publisher, wiring

**Files:**
- Create: `packages/nestjs/src/store-run-gateway.ts`
- Create: `packages/nestjs/src/run-request-responder.ts`
- Modify: `packages/nestjs/src/durable.module.ts` (provide `RunGateway`→`StoreRunGateway`; start responder + re-publisher when the transport supports it)
- Test: `packages/nestjs/src/run-request-responder.spec.ts`

**Interfaces:**
- Consumes: `RunGateway`/`RunDetail` (Task 1), `RunRequest`/`RunReply`/`TenantEvent` + the transport methods (Task 2), `WorkflowEngine`, `StateStore` (`STATE_STORE_CANONICAL`), `EngineEvent`.
- Produces: `RUN_GATEWAY` injection token (a `Symbol.for('nestjs-durable:run-gateway')` in `packages/nestjs/src` — export it), `StoreRunGateway` (implements `RunGateway`), `RunRequestResponder`.

**Design:** `StoreRunGateway` does exactly what `DashboardService`'s six methods do (`store.getRun`+`listCheckpoints`+`engine.getRunChildren`; `store.listRuns`; `engine.cancel`; `engine.requeue` for `retry`; `engine.continue`; `engine.retryWithInput`; `engine.subscribe` filtered by runId for `subscribe`). The `RunRequestResponder` wraps a `RunGateway` and applies tenant-scoping around it.

- [ ] **Step 1: Write the failing test**

`packages/nestjs/src/run-request-responder.spec.ts` — drive the responder with a fake transport + a fake `RunGateway`, assert scoping + reply. Sketch:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RunRequestResponder } from './run-request-responder';

function fakeGateway(overrides = {}) {
  return {
    getRunDetail: vi.fn(async (id: string) => ({ run: { id, namespace: 'acme' }, timeline: [], children: [] })),
    listRuns: vi.fn(async (q) => [{ id: 'x', namespace: q.namespace }]),
    cancel: vi.fn(async () => null),
    retry: vi.fn(async () => null),
    continue: vi.fn(async () => null),
    retryWithInput: vi.fn(async () => ({ runId: 'n' })),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  };
}

function fakeTransport() {
  let onReq: (m) => Promise<void>;
  const replies = [];
  return {
    onRunRequest: (h) => { onReq = h; },
    publishRunReply: async (r) => { replies.push(r); },
    deliver: (m) => onReq(m),
    replies,
  };
}

describe('RunRequestResponder', () => {
  it('answers getRunDetail scoped to the tenant', async () => {
    const gw = fakeGateway(); const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({ requestId: 'q1', tenant: 'acme', body: { kind: 'getRunDetail', runId: 'r1' } });
    expect(tx.replies[0]).toMatchObject({ requestId: 'q1', result: { ok: true } });
  });

  it('denies a cross-tenant getRunDetail and never calls the verb again', async () => {
    const gw = fakeGateway({ getRunDetail: vi.fn(async (id) => ({ run: { id, namespace: 'beta' }, timeline: [], children: [] })) });
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({ requestId: 'q2', tenant: 'acme', body: { kind: 'getRunDetail', runId: 'r1' } });
    expect(tx.replies[0]).toMatchObject({ requestId: 'q2', result: { ok: false, error: { code: 'cross-tenant' } } });
  });

  it('forces listRuns namespace to the tenant', async () => {
    const gw = fakeGateway(); const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({ requestId: 'q3', tenant: 'acme', body: { kind: 'listRuns', query: { namespace: 'beta' } } });
    expect(gw.listRuns).toHaveBeenCalledWith({ namespace: 'acme' });
  });

  it('denies a cross-tenant cancel WITHOUT calling engine cancel', async () => {
    const gw = fakeGateway({ getRunDetail: vi.fn(async (id) => ({ run: { id, namespace: 'beta' }, timeline: [], children: [] })) });
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({ requestId: 'q4', tenant: 'acme', body: { kind: 'cancel', runId: 'r1' } });
    expect(gw.cancel).not.toHaveBeenCalled();
    expect(tx.replies[0].result).toMatchObject({ ok: false, error: { code: 'cross-tenant' } });
  });

  it('serialises a thrown verb error into an error reply', async () => {
    const gw = fakeGateway({
      getRunDetail: vi.fn(async (id) => ({ run: { id, namespace: 'acme' }, timeline: [], children: [] })),
      cancel: vi.fn(async () => { throw new Error('already terminal'); }),
    });
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({ requestId: 'q5', tenant: 'acme', body: { kind: 'cancel', runId: 'r1' } });
    expect(tx.replies[0].result).toMatchObject({ ok: false, error: { message: 'already terminal' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- run-request-responder`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `StoreRunGateway`**

`packages/nestjs/src/store-run-gateway.ts` — a `@Injectable()` class `constructor(@Inject(STATE_STORE_CANONICAL) store, engine: WorkflowEngine)` implementing `RunGateway` with the exact bodies from `DashboardService` (`dashboard.service.ts:76-172`): `getRunDetail` (store.getRun→null-guard→Promise.all[listCheckpoints, engine.getRunChildren]→`{run,timeline,children}`), `listRuns`→`store.listRuns`, `cancel`→`engine.cancel`, `retry`→`engine.requeue`, `continue`→`engine.continue`, `retryWithInput`→`engine.retryWithInput`, `subscribe(runId,onEvent)`→`engine.subscribe((e)=>{ if(e.runId===runId) onEvent(e); })` returning the off fn.

- [ ] **Step 4: Implement `RunRequestResponder`**

`packages/nestjs/src/run-request-responder.ts` — `constructor(private transport: Transport, private gateway: RunGateway)`. A `start()` that registers `transport.onRunRequest(async (msg) => { const reply = await this.handle(msg); await this.transport.publishRunReply?.(reply); })`. `handle(msg)`:
- For a runId-bearing verb (`getRunDetail`/`cancel`/`retry`/`continue`/`retryWithInput`): first `const detail = await this.gateway.getRunDetail(runId)`; if `detail && detail.run.namespace !== msg.tenant` → return `{requestId, result:{ok:false, error:{message:'run belongs to another tenant', code:'cross-tenant'}}}` (do NOT call the verb). If `detail === null` and the verb is `getRunDetail`, reply `{ok:true, data:null}`. Otherwise call the verb, wrapped in try/catch → `{ok:false, error:{message:e.message}}`.
- For `listRuns`: call `this.gateway.listRuns({ ...body.query, namespace: msg.tenant })` (force namespace), reply `{ok:true, data}`.
- Return `{ requestId: msg.requestId, result }`.

Note: `WorkflowRun.namespace` is the field to compare (`interfaces.ts:66`).

- [ ] **Step 5: Wire into `DurableModule` + event re-publisher**

In `durable.module.ts`, in the operator (worker/drive) providers: provide `{ provide: RUN_GATEWAY, useClass: StoreRunGateway }`. After the engine is built, if the transport implements `onRunRequest` (capability check `typeof transport.onRunRequest === 'function'`), construct and `start()` a `RunRequestResponder(transport, <resolved RUN_GATEWAY>)`. Add the event re-publisher: `engine.subscribe((event) => { const ns = <run namespace for event.runId>; if (ns) transport.publishTenantEvent?.({ tenant: ns, event }); })`. To get the namespace without a store round-trip per event, carry it on the event if available; otherwise the re-publisher may `store.getRun(event.runId)` — acceptable at lifecycle-event frequency, but prefer reading `event`'s namespace if `EngineEvent` carries one (check `EngineEvent` shape ~`interfaces.ts:1237`; if it lacks `namespace`, add `namespace?` to the emitted event in `engine.ts emit()` where the run is in hand — a one-line addition — rather than a per-event store read). Decide during implementation and note which path was taken.

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm test -- run-request-responder` then `pnpm --filter @dudousxd/nestjs-durable typecheck`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add packages/nestjs/src/store-run-gateway.ts packages/nestjs/src/run-request-responder.ts packages/nestjs/src/durable.module.ts packages/nestjs/src/run-request-responder.spec.ts packages/core/src/engine.ts packages/nestjs/src/index.ts
git commit -m "feat(nestjs): operator RunRequestResponder + StoreRunGateway + tenant-event re-publisher"
```

---

## Task 4: Tenant — `ProxyRunGateway` + `DurableWorkerModule` wiring

**Files:**
- Create: `packages/nestjs/src/proxy-run-gateway.ts`
- Modify: `packages/nestjs/src/durable-worker.module.ts` (provide `RUN_GATEWAY`→`ProxyRunGateway`, export it)
- Modify: `packages/nestjs/src/index.ts` (export `ProxyRunGateway`)
- Test: `packages/nestjs/src/proxy-run-gateway.spec.ts`

**Interfaces:**
- Consumes: `RunGateway` (Task 1), the transport reply/request/tenant-event methods (Task 2), `RUN_GATEWAY` token (Task 3), `DurableWorkerModuleOptions` (`tenant`).
- Produces: `ProxyRunGateway implements RunGateway`.

**Design:** holds the transport, the tenant name, and a `Map<requestId, {resolve, reject, timer}>`. On construction, `transport.onRunReply((reply) => { const pending = this.pending.get(reply.requestId); if (!pending) return; clear timer; delete; if (reply.result.ok) pending.resolve(reply.result.data); else pending.reject(new Error(reply.result.error.message)); })`. Each verb builds a `RunRequest` (mint `requestId` via `globalThis.crypto.randomUUID()`), registers the pending promise with a timeout (default 10_000ms; reject with a clear message on fire), `dispatchRunRequest`. `subscribe` uses `transport.onTenantEvent(this.tenant, (evt) => { if (evt.event.runId === runId) onEvent(evt.event); })` and returns its unsubscribe fn.

- [ ] **Step 1: Write the failing test**

`packages/nestjs/src/proxy-run-gateway.spec.ts` — drive with a fake transport that lets the test emit replies. Sketch:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ProxyRunGateway } from './proxy-run-gateway';

function fakeTransport() {
  let onReply: (r) => void; let onEvt: (e) => void;
  const requests = [];
  return {
    onRunReply: (h) => { onReply = h; },
    onTenantEvent: (_t, h) => { onEvt = h; return () => {}; },
    dispatchRunRequest: async (m) => { requests.push(m); },
    emitReply: (r) => onReply(r),
    emitEvent: (e) => onEvt(e),
    requests,
  };
}

describe('ProxyRunGateway', () => {
  it('resolves a getRunDetail when the correlated reply arrives', async () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const p = gw.getRunDetail('r1');
    const req = tx.requests[0];
    expect(req).toMatchObject({ tenant: 'acme', body: { kind: 'getRunDetail', runId: 'r1' } });
    tx.emitReply({ requestId: req.requestId, result: { ok: true, data: { run: { id: 'r1' }, timeline: [], children: [] } } });
    await expect(p).resolves.toMatchObject({ run: { id: 'r1' } });
  });

  it('rejects with the operator error', async () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const p = gw.cancel('r1');
    tx.emitReply({ requestId: tx.requests[0].requestId, result: { ok: false, error: { message: 'nope', code: 'cross-tenant' } } });
    await expect(p).rejects.toThrow(/nope/);
  });

  it('rejects on timeout when no reply arrives', async () => {
    vi.useFakeTimers();
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 1000);
    const p = gw.listRuns({});
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow(/did not respond/i);
    vi.useRealTimers();
  });

  it('routes only this run\'s tenant events to subscribe', () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const seen = [];
    gw.subscribe('r1', (e) => seen.push(e));
    tx.emitEvent({ tenant: 'acme', event: { runId: 'r2', type: 'run.completed' } });
    tx.emitEvent({ tenant: 'acme', event: { runId: 'r1', type: 'run.completed' } });
    expect(seen).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- proxy-run-gateway`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ProxyRunGateway`**

`packages/nestjs/src/proxy-run-gateway.ts` — `@Injectable()` class implementing `RunGateway`. Constructor `(transport: Transport, tenant: string, timeoutMs = 10_000)`. Register `onRunReply` once. Private `request<T>(body: RunRequestKind): Promise<T>` that mints a `requestId`, stores `{resolve, reject}` + a `setTimeout(() => { this.pending.delete(id); reject(new Error(\`control plane did not respond to ${body.kind} within ${this.timeoutMs}ms\`)); }, timeoutMs)` in the map, then `await transport.dispatchRunRequest?.(msg)`. Each of the six methods calls `this.request(...)`. Because the reply `data` is `unknown`, each method returns `this.request(...)` typed to the method's return — the narrowing is at the port boundary (the payload originates from the operator's typed gateway; a runtime `Zod`-style guard is unnecessary here, but do NOT use `as` — type `request<T>` generically and let the call sites fix `T`). `subscribe` wires `onTenantEvent`.

- [ ] **Step 4: Wire into `DurableWorkerModule` (app-provided transport)**

`DurableWorkerModule` today has NO transport — only a `connection` (the start path uses the standalone `startRun`). The gateway needs a full `Transport` (a persistent reply/tenant-event subscriber), so — matching how `DurableModule` already takes its transport from the app rather than importing one — add an optional `transport?: Transport` to `DurableWorkerModuleOptions` (import `type Transport` from `@dudousxd/nestjs-durable-core`; document that a tenant that wants `RunGateway` passes e.g. `new BullMQTransport({ connection, group })`, keeping the generic nestjs package free of any transport dependency). Then in `build()` providers add:

```ts
{
  provide: RUN_GATEWAY,
  useFactory: (options: DurableWorkerModuleOptions) =>
    options.transport
      ? new ProxyRunGateway(options.transport, options.tenant ?? 'default', options.runGatewayTimeoutMs)
      : unavailableRunGateway(),  // a RunGateway whose every method rejects with a clear
                                  // "pass `transport` in DurableWorkerModuleOptions to use RunGateway"
  inject: [DURABLE_WORKER_OPTIONS],
},
```

Add `runGatewayTimeoutMs?: number` to the options too (defaults to 10_000 inside `ProxyRunGateway`). Implement `unavailableRunGateway()` as a small helper returning a `RunGateway` whose methods reject with the clear error (mirrors the `DurableStartClient` tenant-error idiom — no store/transport → clear failure, never a cryptic crash). Export `RUN_GATEWAY` + `ProxyRunGateway`. No new package dependency.

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm test -- proxy-run-gateway` then `pnpm --filter @dudousxd/nestjs-durable typecheck`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add packages/nestjs/src/proxy-run-gateway.ts packages/nestjs/src/durable-worker.module.ts packages/nestjs/src/index.ts
git commit -m "feat(nestjs): tenant ProxyRunGateway (request/reply + tenant-event stream) wired into DurableWorkerModule"
```

---

## Task 5: Integration test — tenant ↔ operator over real Redis

**Files:**
- Create: `packages/nestjs/src/tenant-run-gateway.e2e.spec.ts` (or add to the existing real-Redis e2e — match how the current start-run/tenant e2e is set up; reuse its Redis Testcontainer/skip-guard)

**Interfaces:** Consumes everything from Tasks 1–4.

- [ ] **Step 1: Write the failing test**

Stand up an operator engine (real store, `namespace: undefined`, `BullMQTransport`) + a `ProxyRunGateway` pointed at the same Redis with `tenant: 'davi-local'`. Start a run stamped `namespace: 'davi-local'` on the operator. Then, via the proxy:
- `getRunDetail(runId)` resolves the run (namespace `davi-local`).
- `getRunDetail` on a run stamped a DIFFERENT namespace → rejects/`cross-tenant`.
- `cancel(runId)` → the operator run actually becomes `cancelled` (assert via the operator store).
- `subscribe(runId, cb)` receives a `run.*` event when the run settles.

Use the existing e2e's real-Redis harness + polling helpers. Guard-skip when Redis is unavailable exactly as the current e2e does.

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `pnpm test -- tenant-run-gateway.e2e`
Expected: FAIL first (if written before any wiring gap is closed), then PASS once Tasks 1–4 are integrated. If it passes immediately, add an assertion that would have caught a missing scope check (cross-tenant getRunDetail) to prove it exercises the path.

- [ ] **Step 3: Commit**

```bash
git add packages/nestjs/src/tenant-run-gateway.e2e.spec.ts
git commit -m "test(nestjs): e2e tenant ProxyRunGateway <-> operator over real Redis (read/cancel/stream + cross-tenant deny)"
```

---

## Task 6: Changeset + monorepo gate

**Files:** Create `.changeset/tenant-run-gateway.md`.

- [ ] **Step 1: Write the changeset**

```md
---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-transport-bullmq": minor
"@dudousxd/nestjs-durable": minor
---

Tenant run gateway: a store-less tenant worker can now read (getRunDetail/listRuns), control
(cancel/retry/continue/retryWithInput), and live-stream its OWN runs over the shared transport, via a
new `RunGateway` port. The control plane binds a store-backed gateway and answers tenant requests
(scoped to the tenant's namespace) over a new run-request queue + run-reply/tenant-event pub/sub
channels; a tenant binds a `ProxyRunGateway`. No store and no HTTP on the tenant side.
```

- [ ] **Step 2: Full gate**

Run: `pnpm build` (expect all packages), `pnpm test` (expect green), `pnpm -r typecheck` (all Done), `pnpm biome ci .` (clean). Fix any formatting.

- [ ] **Step 3: Commit**

```bash
git add .changeset/tenant-run-gateway.md
git commit -m "chore: changeset for tenant run gateway"
```

---

## Appendix A — flip adoption (gated on the new beta + a dev deploy)

- flip-nestjs `DurableRunController` (`src/control-panel/controller/durable-run.controller.ts`) currently injects `DashboardService` for `getRunDetail`, `streamRun`, `retry`, `cancel`, `continue`, `retryWithInput`. Refactor it to inject the lib's `RUN_GATEWAY` port. Wrap `subscribe(runId, cb)` into the SSE `Observable` the controller returns (the controller keeps its `@Sse` shape; only the source changes).
- Control-plane flip binds `RUN_GATEWAY` → a `DashboardService`-backed adapter (or the lib `StoreRunGateway`). Tenant flip binds `RUN_GATEWAY` → the lib's `ProxyRunGateway` (via `DurableWorkerModule`). Select by the same role switch that picks control-plane vs tenant module (`DURABLE_TENANT`).
- The dashboard SPA (`DurableDashboardModule`) stays mounted only on control-plane flip.

## Appendix B — publish a new beta (gated)

After Tasks 1–6 land on `main` (committed, NOT pushed without confirmation), publish a snapshot beta via `release-snapshot.yml` (`changeset version --snapshot beta` + `changeset publish --tag beta --no-git-tag`) → `0.0.0-beta-<ts>` under the `beta` tag for the three bumped packages. Confirm with Davi before dispatching. Then pin flip's durable deps to the new beta for the Appendix A adoption + live test.
