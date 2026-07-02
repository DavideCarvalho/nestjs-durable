# Topology-Agnostic Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `DashboardService` (and thus `DurableDashboardModule`) depend on the `RUN_GATEWAY` port for run views/control/stream, so a store-less **tenant** can mount the same dashboard the operator uses — instead of a bespoke controller.

**Architecture:** The dashboard's run-facing operations (list, detail, retry, cancel, continue, retry-with-input, live stream, bulk) route through the injected `RUN_GATEWAY` port, which the lib already binds on **both** topologies (`DurableModule` → `StoreRunGateway`; `DurableWorkerModule` → `ProxyRunGateway`). The genuinely operator-only operations (Prometheus metrics, worker health, webhook delivery, live event read, update delivery) keep depending on `WorkflowEngine`/`StateStore`, now made `@Optional()` so the service constructs on a tenant and those operations throw a clear "control-plane only" error there. `DurableWorkerModule` becomes `global: true` (mirroring `DurableModule`) so a globally-mounted dashboard resolves `RUN_GATEWAY` on a tenant.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), NestJS DI, RxJS, vitest, biome, changesets, pnpm+turbo.

## Global Constraints

- No `as`/`any`/`unknown`/`never` casts — use type guards / discriminated unions. (`unknown` as a genuine value type, e.g. `input: unknown`, is fine; forbidden is casting via `as unknown`.)
- `function foo()` declarations, not `const foo = () =>`, for standalone functions.
- Fixed exact dependency versions (no `^`/`~`) — but this increment adds no new deps.
- Preserve existing public behavior on the control plane byte-for-byte: routing an op through `RUN_GATEWAY` on the operator resolves to `StoreRunGateway`, whose bodies are the SAME store/engine calls the dashboard makes today. No control-plane behavior change is acceptable.
- `cancel`'s `compensate` option must survive the refactor on the control plane (do not drop a feature to enable the tenant path).
- Commit locally to `main`. Do NOT push or publish (beta/release) without explicit confirmation.
- Changesets: one changeset covering the changed packages, minor bump.

---

### Task 1: Extend `cancel` with an optional `opts` end-to-end

The dashboard's `cancel(runId, { compensate })` must keep working after it routes through `RUN_GATEWAY`. Today `RunGateway.cancel(runId)` has no `opts`, so routing it through the port would silently drop `compensate`. Widen the port and its two implementations + the wire message additively (optional param — non-breaking).

**Files:**
- Modify: `packages/core/src/run-gateway.ts` — `RunGateway.cancel` signature
- Modify: `packages/core/src/interfaces.ts:489-495` — `RunRequestKind` `cancel` variant
- Modify: `packages/nestjs/src/store-run-gateway.ts:41-43` — pass `opts` to `engine.cancel`
- Modify: `packages/nestjs/src/proxy-run-gateway.ts` — `cancel` sends `opts` in the request body
- Modify: `packages/nestjs/src/run-request-responder.ts` — `callVerb` cancel case passes `opts`
- Test: `packages/nestjs/src/proxy-run-gateway.spec.ts` (or the existing responder/proxy spec) — cancel carries `opts` across the wire

**Interfaces:**
- Consumes: `WorkflowEngine.cancel(runId, opts?: { compensate?: boolean })` (already exists).
- Produces: `RunGateway.cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null>`; `RunRequestKind` cancel variant `{ kind: 'cancel'; runId: string; opts?: { compensate?: boolean } }`.

- [ ] **Step 1: Write the failing test** — a `ProxyRunGateway.cancel(runId, { compensate: true })` puts `opts` on the dispatched request body; a `RunRequestResponder` handling that body calls `gateway.cancel(runId, { compensate: true })`.

Add to the proxy spec (fake transport capturing the dispatched request):
```ts
it('cancel carries compensate opts across the wire', async () => {
  const dispatched: RunRequest[] = [];
  const transport = fakeTransport({ onDispatch: (req) => dispatched.push(req) });
  const proxy = new ProxyRunGateway(transport, 'tenant-a');
  void proxy.cancel('run-1', { compensate: true });
  expect(dispatched[0]?.body).toEqual({ kind: 'cancel', runId: 'run-1', opts: { compensate: true } });
});
```
And to the responder spec (fake gateway recording calls):
```ts
it('passes cancel opts to the gateway', async () => {
  const calls: Array<{ runId: string; opts?: { compensate?: boolean } }> = [];
  const gateway = fakeGateway({
    getRunDetail: async () => ({ run: runIn('tenant-a'), timeline: [], children: [] }),
    cancel: async (runId, opts) => { calls.push({ runId, opts }); return null; },
  });
  const responder = new RunRequestResponder(fakeReplyTransport(), gateway);
  await responder.handleForTest({ requestId: 'r1', tenant: 'tenant-a', body: { kind: 'cancel', runId: 'run-1', opts: { compensate: true } } });
  expect(calls[0]).toEqual({ runId: 'run-1', opts: { compensate: true } });
});
```
Use whatever fake/harness the existing specs in these files already use (match their style; if `handle` is private, exercise it through the public `start()` path the existing tests use). Do NOT invent a new harness if one exists.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/nestjs && pnpm vitest run src/proxy-run-gateway.spec.ts src/run-request-responder.spec.ts`
Expected: FAIL — `opts` missing on body / not forwarded.

- [ ] **Step 3: Implement**

`packages/core/src/run-gateway.ts`:
```ts
cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null>;
```

`packages/core/src/interfaces.ts` cancel variant:
```ts
  | { kind: 'cancel'; runId: string; opts?: { compensate?: boolean } }
```

`packages/nestjs/src/store-run-gateway.ts`:
```ts
  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return this.engine.cancel(runId, opts);
  }
```

`packages/nestjs/src/proxy-run-gateway.ts`:
```ts
  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return this.request<RunResult | null>({ kind: 'cancel', runId, opts });
  }
```
(With `exactOptionalPropertyTypes`, spreading an absent `opts` is fine — `{ kind: 'cancel', runId, opts }` where `opts` is `undefined` is assignable to the optional field.)

`packages/nestjs/src/run-request-responder.ts` `callVerb`:
```ts
      case 'cancel':
        return this.gateway.cancel(body.runId, body.opts);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/nestjs && pnpm vitest run src/proxy-run-gateway.spec.ts src/run-request-responder.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -r typecheck`
```bash
git add packages/core/src/run-gateway.ts packages/core/src/interfaces.ts packages/nestjs/src/store-run-gateway.ts packages/nestjs/src/proxy-run-gateway.ts packages/nestjs/src/run-request-responder.ts packages/nestjs/src/proxy-run-gateway.spec.ts packages/nestjs/src/run-request-responder.spec.ts
git commit -m "feat(core): RunGateway.cancel accepts optional compensate opts end-to-end"
```

---

### Task 2: Lock the store-backed run-op semantics in a `StoreRunGateway` spec (before the dashboard starts delegating)

`StoreRunGateway` (`packages/nestjs/src/store-run-gateway.ts`) owns the run-op bodies verbatim (its docstring says so), yet has **no dedicated spec** — today those bodies are only exercised through `DashboardService`'s real-engine tests in `packages/dashboard/src/server/dashboard.service.spec.ts`. Task 3 rewrites that dashboard spec to a fake gateway, which would drop the real-engine coverage. Port it here first, pointed at `StoreRunGateway`, so the semantics stay locked. **Product code unchanged in this task.**

**Files:**
- Create: `packages/nestjs/src/store-run-gateway.spec.ts`

**Interfaces:**
- Consumes: `StoreRunGateway` (from Task 1, now with `cancel(runId, opts?)`), `WorkflowEngine`, `InMemoryStateStore` — all offline, no Redis.

- [ ] **Step 1: Port the real-engine integration tests**

Copy the real-engine tests currently in `dashboard.service.spec.ts` (bulk-retry-by-tag, list-runs-and-timeline, and any getRunDetail/subscribe/cancel/retry cases) into `store-run-gateway.spec.ts`, replacing `new DashboardService(store, engine)` with `new StoreRunGateway(store, engine)` and calling the gateway's methods (`listRuns`, `getRunDetail`, `retry`, `cancel`, `retryWithInput`, `subscribe`). `bulk` is NOT on `StoreRunGateway` (it's a dashboard concern) — for the bulk-retry semantics, assert the equivalent via `gateway.retry(runId)` re-enqueuing a failed run (`status` → `pending`, then `engine.runPending()` completes it). Match the existing spec's engine-driving style (`engine.register` → `engine.start` → `engine.waitForRun`). Add one `cancel(runId, { compensate: true })` case proving opts reach `engine.cancel`.

- [ ] **Step 2: Run to verify GREEN** (this is added coverage of existing behavior, so it passes immediately)

Run: `cd packages/nestjs && pnpm vitest run src/store-run-gateway.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**
```bash
git add packages/nestjs/src/store-run-gateway.spec.ts
git commit -m "test(nestjs): lock StoreRunGateway run-op semantics against a real engine"
```

---

### Task 3: Route `DashboardService` run-ops through `RUN_GATEWAY`; make store/engine optional

**Files:**
- Modify: `packages/dashboard/src/server/dashboard.service.ts`
- Create: `packages/dashboard/src/server/tokens.ts` (local `RUN_GATEWAY` by value — dashboard has NO dep on `@dudousxd/nestjs-durable`, only `-core` peer; mirror the `Symbol.for` by-value pattern)
- Rewrite: `packages/dashboard/src/server/dashboard.service.spec.ts` — the existing real-engine tests were ported to `store-run-gateway.spec.ts` in Task 2; REPLACE them here with fake-gateway delegation + guard + operator-present tests (the constructor signature changed to `(gateway, store?, engine?)`, so the old `new DashboardService(store, engine)` tests no longer compile and must go)

**Interfaces:**
- Consumes: `RUN_GATEWAY` token from `@dudousxd/nestjs-durable` — WAIT: dashboard package must not create a dep cycle. `RUN_GATEWAY` is `Symbol.for('nestjs-durable:run-gateway')` declared in `packages/nestjs/src/tokens.ts`. The dashboard already depends on `@dudousxd/nestjs-durable-core`, not on `@dudousxd/nestjs-durable`. To avoid importing the nestjs package from the dashboard package (check `packages/dashboard/package.json` deps first), declare the token locally by value: `export const RUN_GATEWAY = Symbol.for('nestjs-durable:run-gateway');` in a small `packages/dashboard/src/server/tokens.ts`, mirroring the CONTEXT_ACCESSOR-by-value pattern already used in `packages/nestjs/src/tokens.ts`. `Symbol.for` resolves to the SAME registered provider. If the dashboard package ALREADY depends on `@dudousxd/nestjs-durable`, import `RUN_GATEWAY` from there instead — prefer a real import over a by-value redecl when the dep already exists.
- Consumes: `RunGateway` type from `@dudousxd/nestjs-durable-core`.
- Produces: `DashboardService` with the same public method names/return types as today. Its `RunDetail` export stays stable (structurally `{ run: WorkflowRun; timeline: StepCheckpoint[]; children: string[] }`, Date fields) — source it from the gateway's `RunGateway.getRunDetail` return, which is core's `RunDetail` of identical shape. Keep exporting `RunDetail` from `packages/dashboard/src/server/index.ts` (re-export core's or keep the local alias — either, as long as the exported name and shape are unchanged).

Constructor after refactor:
```ts
  constructor(
    @Inject(RUN_GATEWAY) private readonly gateway: RunGateway,
    @Optional() @Inject(STATE_STORE_CANONICAL) private readonly store?: StateStore,
    @Optional() private readonly engine?: WorkflowEngine,
  ) {
    this.metricsCollector = this.engine ? collectMetrics(this.engine) : undefined;
  }
```
`metricsCollector` becomes `MetricsCollector | undefined`.

Op routing:
- `listRuns(query)` → `this.gateway.listRuns(query)`
- `getRunDetail(runId)` → `this.gateway.getRunDetail(runId)`
- `retry(runId)` → `this.gateway.retry(runId)`
- `cancel(runId, opts)` → `this.gateway.cancel(runId, opts)`
- `continue(runId)` → `this.gateway.continue(runId)`
- `retryWithInput(runId, input)` → `this.gateway.retryWithInput(runId, input)`
- `streamRun(runId)` → wrap `this.gateway.subscribe(runId, (event) => subscriber.next({ data: event }))` in the `Observable` (unsubscribe via the returned fn) — no engine.
- `bulk(action, filter, opts)` → `this.gateway.listRuns({ ...filter, limit: 500 })` then loop `this.gateway.retry(r.id)` / `this.gateway.cancel(r.id, opts)` in the same try/catch. No store/engine.

Operator-only ops (keep on engine/store, guarded). Add private guards:
```ts
  private requireEngine(): WorkflowEngine {
    if (!this.engine) throw new Error('This durable dashboard operation requires the control plane (no engine on a tenant deployment).');
    return this.engine;
  }
  private requireStore(): StateStore {
    if (!this.store) throw new Error('This durable dashboard operation requires the control plane (no store on a tenant deployment).');
    return this.store;
  }
```
- `metrics()` → uses `this.requireStore()` for the three `listRuns` gauges, `this.requireEngine().workerHealth()`, and `this.metricsCollector?.prometheus() ?? ''` for the counters prefix. (All three sub-parts need the control plane; guarding store+engine is sufficient — call `requireStore()`/`requireEngine()` as used.)
- `workerHealth()` → `this.requireEngine().workerHealth()`
- `deliverWebhook(token, body)` → `this.requireEngine().signal(token, body)`
- `getEvent(runId, key)` → `this.requireEngine().getEvent(runId, key)`
- `update(runId, name, arg)` → `this.requireEngine().update(runId, name, arg)`

- [ ] **Step 1: Write the failing tests**

Rewrite `packages/dashboard/src/server/dashboard.service.spec.ts` (drop the ported real-engine tests). Use a fake `RunGateway` (records calls) and construct `new DashboardService(fakeGateway)` with no store/engine (the tenant shape):
```ts
it('routes run-ops through the gateway (tenant shape: no store/engine)', async () => {
  const calls: string[] = [];
  const gateway = fakeGateway({ record: (m) => calls.push(m) });
  const svc = new DashboardService(gateway); // store/engine undefined
  await svc.listRuns({});
  await svc.getRunDetail('r1');
  await svc.retry('r1');
  await svc.cancel('r1', { compensate: true });
  await svc.continue('r1');
  await svc.retryWithInput('r1', { fixed: true });
  expect(calls).toEqual(['listRuns', 'getRunDetail', 'retry', 'cancel:{"compensate":true}', 'continue', 'retryWithInput']);
});

it('bulk goes through the gateway, scoped and capped', async () => {
  const gateway = fakeGateway({ listRuns: async () => [{ id: 'a' }, { id: 'b' }] as WorkflowRun[] });
  const svc = new DashboardService(gateway);
  const res = await svc.bulk('cancel', { status: 'dead' }, { compensate: true });
  expect(res).toEqual({ matched: 2, applied: 2 });
});

it('operator-only ops throw a clear error without the control plane', async () => {
  const svc = new DashboardService(fakeGateway({}));
  await expect(svc.workerHealth()).rejects.toThrow(/control plane/);
  await expect(svc.metrics()).rejects.toThrow(/control plane/);
  await expect(svc.getEvent('r1', 'k')).rejects.toThrow(/control plane/);
  await expect(svc.update('r1', 'u', {})).rejects.toThrow(/control plane/);
  await expect(svc.deliverWebhook('tok', {})).rejects.toThrow(/control plane/);
});

it('streamRun emits only the target run\'s events via gateway.subscribe', () => {
  let handler: ((e: EngineEvent) => void) | undefined;
  const gateway = fakeGateway({ subscribe: (runId, on) => { handler = on; return () => {}; } });
  const svc = new DashboardService(gateway);
  const seen: EngineEvent[] = [];
  svc.streamRun('r1').subscribe((m) => seen.push(m.data));
  handler?.({ type: 'run.started', runId: 'r1' } as EngineEvent);
  handler?.({ type: 'run.started', runId: 'other' } as EngineEvent);
  // ProxyRunGateway already filters by runId; StoreRunGateway.subscribe filters too — but the dashboard
  // passes runId to subscribe and trusts the gateway's filter. Assert the wired-through event is seen.
  expect(seen.map((e) => e.runId)).toContain('r1');
});
```
Add a control-plane test that with store+engine present the operator ops still work (fake store returning `[]`, fake engine returning `[]` for workerHealth) — mirror the existing behavior so the reviewer sees no regression:
```ts
it('operator-only ops work when store+engine are present', async () => {
  const svc = new DashboardService(fakeGateway({}), fakeStore({ listRuns: async () => [] }), fakeEngine({ workerHealth: async () => [] }));
  await expect(svc.workerHealth()).resolves.toEqual([]);
  await expect(svc.metrics()).resolves.toContain('durable_pending_runs 0');
});
```
Match the fakes to the real `RunGateway`/`StateStore`/`WorkflowEngine` shapes — only stub the methods each test path touches; a minimal object typed to the interface is fine (no `as` — build a typed partial via a small helper that returns the interface, or implement the few methods used).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/dashboard && pnpm vitest run src/server/dashboard.service.spec.ts`
Expected: FAIL — constructor still requires store+engine; ops still hit store/engine.

- [ ] **Step 3: Implement the refactor** per the routing above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/dashboard && pnpm vitest run src/server/dashboard.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -r typecheck`
```bash
git add packages/dashboard/src/server/dashboard.service.ts packages/dashboard/src/server/dashboard.service.spec.ts packages/dashboard/src/server/index.ts packages/dashboard/src/server/tokens.ts
git commit -m "refactor(dashboard): route run-ops through RUN_GATEWAY; store/engine optional (control-plane-only ops)"
```

---

### Task 4: Make the dashboard actually tenant-mountable — `DurableWorkerModule` global, control-plane guard fix, integration test; changeset; gate

This is where the tenant DI reality is exercised end-to-end, and it exposes TWO defects the earlier tasks' unit tests could not (their "tenant shape" was `new DashboardService(gateway)` with store/engine BOTH undefined — but the REAL tenant has `engine` PRESENT):

- On a tenant, the `WorkflowEngine` token resolves to a **store-less `DurableStartClient`** (`durable-worker.module.ts:232` `useFactory: () => new DurableStartClient(options)`), which implements NONE of `subscribe`/`workerHealth`/`getEvent`/`update`/`getRunChildren`. So `this.engine` is truthy on a tenant.
  - **Boot break:** the constructor's `this.metricsCollector = this.engine ? collectMetrics(this.engine) : undefined` calls `collectMetrics(startClient)`, which calls `engine.subscribe(...)` (`core/src/metrics.ts:28`) — `subscribe` is undefined on the start client → **TypeError at construction → the tenant cannot boot the dashboard.**
  - **Leaky guard:** the operator-only ops use `requireEngine()` (presence of engine), which PASSES on a tenant (engine present) → they call the start client's missing methods and throw a confusing `undefined is not a function` instead of the clean "control plane only" error.

The reliable control-plane-vs-tenant discriminator is the **canonical store**: a tenant's `DurableWorkerModule` provides NO `STATE_STORE_CANONICAL` (verified — no `STATE_STORE` in `durable-worker.module.ts`), while the control-plane `DurableModule` always provides it AND the full engine. So gate the operator-only ops and the metrics-collector init on **store presence** (which implies a full engine), not engine presence.

**Files:**
- Modify: `packages/dashboard/src/server/dashboard.service.ts` — guard fix (gate on store; single `controlPlane()` helper) + metrics-collector init gate
- Modify: `packages/nestjs/src/durable-worker.module.ts` — add `global: true` to the `forRoot` DynamicModule return (mirror `durable.module.ts:414`)
- Test: `packages/nestjs/src/tenant-dashboard.module.spec.ts` (new — an integration spec that boots a real tenant `DurableWorkerModule` + `DurableDashboardModule`)
- Create: `.changeset/topology-agnostic-dashboard.md`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: `DurableWorkerModule.forRoot(...)` returns `{ ..., global: true }`; `DashboardService` operator-only ops gate on store presence.

- [ ] **Step 1: Guard fix in `dashboard.service.ts`**

Replace the two helpers (`requireEngine` + `requireStore`, `dashboard.service.ts:50-66`) with ONE control-plane gate, and gate the metrics collector init on store presence:

Constructor (line 47):
```ts
    // Only the control plane (which has the canonical store) has a FULL engine to accumulate from;
    // on a tenant `this.engine` is a store-less start client with no `subscribe`, so guard on store.
    this.metricsCollector = this.store && this.engine ? collectMetrics(this.engine) : undefined;
```

Replace `requireEngine`/`requireStore` with:
```ts
  /**
   * The operator-only ops need the FULL engine + canonical store, which only the control plane has.
   * On a tenant the `WorkflowEngine` token is a store-less start client that implements none of these
   * methods, so presence of the canonical store is the reliable discriminator — gate on it (never
   * on engine presence, which is truthy on a tenant too).
   */
  private controlPlane(): { store: StateStore; engine: WorkflowEngine } {
    if (!this.store || !this.engine) {
      throw new Error(
        'This durable dashboard operation requires the control plane (not available on a tenant deployment).',
      );
    }
    return { store: this.store, engine: this.engine };
  }
```

Rewire the 5 operator-only ops:
```ts
  async metrics(): Promise<string> {
    const { store, engine } = this.controlPlane();
    // ... unchanged body, using `store.listRuns(...)` and `engine.workerHealth()` ...
  }

  async workerHealth(): Promise<GroupHealth[]> {
    return this.controlPlane().engine.workerHealth();
  }

  async deliverWebhook(token: string, body: unknown): Promise<RunResult | null> {
    return this.controlPlane().engine.signal(token, body);
  }

  async getEvent(runId: string, key: string): Promise<unknown> {
    return this.controlPlane().engine.getEvent(runId, key);
  }

  async update(runId: string, name: string, arg: unknown): Promise<UpdateResult> {
    return this.controlPlane().engine.update(runId, name, arg);
  }
```
(Run-ops, `bulk`, `streamRun`, `getRunDetail` are UNCHANGED — they go through the gateway.)

- [ ] **Step 2: Write the failing integration test** — `packages/nestjs/src/tenant-dashboard.module.spec.ts`

Boot a REAL tenant `DurableWorkerModule` (offline — reuse the EXISTING `durable-worker.module.spec.ts` boot harness: it overrides the `runRedisWorker` provider via `.overrideProvider(...).useValue(runner.runRedisWorker)` so nothing connects to Redis; read that spec and copy its `makeRunner()`/override setup and the provider token it overrides) plus `DurableDashboardModule.forRoot()`, and supply a fake `Transport` capturing dispatched run-requests:
```ts
it('a tenant boots the dashboard and drives runs through the ProxyRunGateway', async () => {
  const dispatched: Array<{ tenant: string; body: { kind: string; runId?: string; opts?: unknown } }> = [];
  const transport = fakeTenantTransport({ onDispatch: (req) => dispatched.push(req) });
  const runner = makeRunner(); // from the existing worker-module spec harness
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableWorkerModule.forRoot({ connection: 'redis://x', groups: ['pipeline'], tenant: 'tenant-a', transport }),
      DurableDashboardModule.forRoot(),
    ],
  })
    .overrideProvider(/* the runRedisWorker token the existing spec overrides */)
    .useValue(runner.runRedisWorker)
    .compile();

  // Resolving DashboardService proves: (a) RUN_GATEWAY resolves globally on a tenant, and
  // (b) the constructor did NOT boot-break on collectMetrics(startClient).
  const dashboard = moduleRef.get(DashboardService, { strict: false });

  // Run-op: reaches the transport as a proxy request, scoped to the tenant, opts threaded.
  void dashboard.cancel('run-1', { compensate: true });
  expect(dispatched[0]).toMatchObject({ tenant: 'tenant-a', body: { kind: 'cancel', runId: 'run-1', opts: { compensate: true } } });

  // Operator-only op: cleanly rejects on a tenant (does NOT call the start client's missing methods).
  await expect(dashboard.workerHealth()).rejects.toThrow(/control plane/);
  await expect(dashboard.metrics()).rejects.toThrow(/control plane/);

  await moduleRef.close();
});
```
The `fakeTenantTransport` must implement at least the `Transport` methods the module touches at init + the proxy uses: `onRunReply(handler)`, `onTenantEvent(tenant, handler)` (return an unsubscribe fn), `dispatchRunRequest(req)` (push to the capture array, resolve). If the module's boot calls other `Transport` methods, implement them as no-ops — add whatever the compile surfaces as missing. Build it as a typed object satisfying `Transport` (no `as`); if `Transport` is a wide interface, define a small `function fakeTenantTransport(...)` returning an object with the needed methods typed to `Transport` — mirror the `fakeTransport()` in `proxy-run-gateway.spec.ts` and widen as the worker-module boot requires.

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/nestjs && pnpm vitest run src/tenant-dashboard.module.spec.ts`
Expected: FAIL — before `global: true`, `DashboardService` can't resolve `RUN_GATEWAY` (Nest "can't resolve dependencies"); even with resolution, the constructor boot-breaks on `collectMetrics(startClient)` until the Step-1 guard fix lands. (Step 1 is already applied above, so the failure you should see here is the RUN_GATEWAY resolution / not-global one.)

- [ ] **Step 4: Implement `global: true`**

In `packages/nestjs/src/durable-worker.module.ts`, add `global: true` to the object `forRoot` returns (alongside `module`, `imports`, `providers`, `exports`), mirroring `durable.module.ts:414`. Do the same for `forRootAsync` if it returns a separate object and the existing tests mount it (check — keep them symmetric).

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/nestjs && pnpm vitest run src/tenant-dashboard.module.spec.ts`
Expected: PASS. Also re-run the dashboard spec to confirm the guard refactor didn't regress it: `cd packages/dashboard && pnpm vitest run src/server/dashboard.service.spec.ts` (its guard tests assert `/control plane/`, which the new `controlPlane()` message still satisfies; its "operator ops work with store+engine present" test still passes since both are present).

- [ ] **Step 6: Changeset + full gate + commit**

Create `.changeset/topology-agnostic-dashboard.md`:
```md
---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

Topology-agnostic dashboard: `DashboardService` run views/control/stream now route through the `RUN_GATEWAY` port, so a store-less tenant can mount the same `DurableDashboardModule` the operator uses (backed by `ProxyRunGateway`). `RunGateway.cancel` gains an optional `compensate` opts; `DurableWorkerModule` is now `global` so a globally-mounted dashboard resolves `RUN_GATEWAY` on a tenant. Operator-only operations (metrics, worker health, webhook delivery, live event read, update delivery) require the control plane and throw a clear error on a tenant.
```

Full gate (repo root):
```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm biome ci .
```
Expected: all green.

```bash
git add packages/dashboard/src/server/dashboard.service.ts packages/nestjs/src/durable-worker.module.ts packages/nestjs/src/tenant-dashboard.module.spec.ts .changeset/topology-agnostic-dashboard.md
git commit -m "feat(nestjs): tenant-mountable dashboard — DurableWorkerModule global + store-gated operator ops"
```

---

## Notes / out of scope

- **SPA tenant polish:** the bundled React SPA's overview may call `/metrics` and `/workers`, which now throw on a tenant. Hiding/degrading those panels in tenant mode is a **frontend follow-up**, not part of this increment. Flagged to the user; decide after a live look (needs a deploy).
- **flip rewire:** once this ships, flip's bespoke `DurableRunController` can be dropped in favor of mounting the topology-agnostic `DurableDashboardModule` directly. Separate change, gated on Davi + a deploy.
