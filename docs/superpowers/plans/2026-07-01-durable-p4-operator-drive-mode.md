# P4-close: Operator Drive Mode + Tenant Group Routing

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Close the P4 (start-run / hosted control plane) increment so a single **operator** control plane (namespace UNSET) drives runs of *every* tenant, and a pure tenant worker declares its `tenant` as a data label on a **shared** transport — routed to the right worker by a **tenant-suffixed group name** (`<workflow>@<tenant>`), the decision/result/heartbeat channels staying on the operator's shared prefix.

**Architecture:** Extends the design's "ver tudo = ausência de namespace" from the store READS (shipped) to the engine DRIVE paths, and resolves the wire-routing gap the symmetric per-namespace prefix left: instead of partitioning every queue by namespace (which puts the operator and a tenant worker on disjoint queues), the tenant rides as (a) a **group suffix** for outbound task routing and (b) a **field on the start-run message** for stamping — while decisions/results/step-events/heartbeat stay on the shared prefix so the operator receives them without knowing tenants ahead of time. The routing rule lives at the transport-agnostic **group** layer (the engine picks the group; the transport just routes by group), so it holds across transport implementations, not only BullMQ.

**Tech Stack:** TypeScript (packages/core, packages/worker, packages/nestjs), Python (clients/python/durable_worker), Vitest, pytest, changesets, biome.

## Global Constraints

- `function` declarations, not arrow consts; descriptive names; **no `as`/`any`/`unknown`/`never`** — type guards / discriminated unions; add no new deps.
- **Backward compatible + production byte-identical:** tenant `default` (or unset) → **bare** group `<workflow>` (mirrors `#effectivePrefix`'s default-is-bare rule); a namespace-scoped engine (`namespace: 'x'`) behaves exactly as today; existing `engine.remote()`/`registerRemote()` untouched.
- The tenant→group rule is ONE shared helper (`tenantGroup`) in `packages/core`, imported by engine + TS worker; **replicated byte-identically** in Python (`_tenant_group`) with a cross-SDK conformance assertion.
- Ship a changeset per package touched; bump MINOR.
- Green gate: full-workspace `pnpm build`, `pnpm typecheck`, `pnpm test`, `biome` (biome format --write changed files); Python `pytest` + `py_compile`.
- NO Co-Authored-By. Stage explicit paths (never `git add -A`). Commit to `main` locally; DO NOT push/publish (release is CI on merge of the Version PR).

---

### Task P4C.1: Core — operator drive mode + tenant-aware `remoteByConvention` group

**Files:**
- Create: `packages/core/src/tenant-group.ts`
- Modify: `packages/core/src/engine.ts` (namespace field :325, assignment :395, useNamespace :399, resume guard :926, completeRemoteDecision guard :2742, resolveRemoteByConvention :1004-1020)
- Test: `packages/core/src/operator-drive-mode.spec.ts` (create), `packages/core/src/tenant-group.spec.ts` (create)

**Interfaces:**
- Produces:
  - `export function tenantGroup(baseGroup: string, tenant: string | undefined): string` — returns `` `${baseGroup}@${tenant}` `` when `tenant` is a non-empty string other than `'default'`, else `baseGroup`.
  - Engine field `namespace: string | undefined` (was `string`). `WorkflowEngineDeps.namespace` already `string | undefined` — unchanged.
- Consumes: `this.pool.listWorkerGroups()`, `RemoteWorkflowExecutor(transport, group)`, `this.pool.primary`, `run.namespace`, `run.workflow`, `run.workflowVersion`.

- [ ] **Step 1: Write `tenant-group.spec.ts` (failing)** — `tenantGroup('processing', undefined) === 'processing'`; `tenantGroup('processing', 'default') === 'processing'`; `tenantGroup('processing', 'davi-local') === 'processing@davi-local'`; `tenantGroup('processing', '') === 'processing'`.
- [ ] **Step 2: Implement `tenant-group.ts`.**
```ts
export function tenantGroup(baseGroup: string, tenant: string | undefined): string {
  return tenant !== undefined && tenant !== '' && tenant !== 'default'
    ? `${baseGroup}@${tenant}`
    : baseGroup;
}
```
- [ ] **Step 3: Write `operator-drive-mode.spec.ts` (failing).** Build a fake store holding runs across namespaces `'default'` and `'t1'` and a fake transport whose `listWorkerGroups()` returns `['processing', 'processing@t1']` (follow the fakes in `remote-by-convention.spec.ts` / `namespace-engine.spec.ts`). Assert:
  1. **Operator drives all namespaces:** an engine with `namespace: undefined`, `remoteByConvention: true` — `runPending`/`recoverIncomplete`/`resumeDueTimers` pick up BOTH the `default` and the `t1` pending run (the store already returns all when the namespace arg is `undefined`).
  2. **Operator routes by tenant group:** dispatching the `t1` `processing` run resolves to group `processing@t1`; the `default` `processing` run resolves to bare `processing`.
  3. **Operator resume/decision cross-namespace:** `resume(t1RunId)` does NOT throw `NamespaceMismatch`; `completeRemoteDecision` for a `t1` run is NOT dropped.
  4. **Scoped engine unchanged (regression):** an engine with `namespace: 'default'` still throws `NamespaceMismatch` on `resume` of the `t1` run and drops its foreign decision; and its `runPending` ignores the `t1` run.
- [ ] **Step 4: Run to verify failure** — `pnpm -C packages/core test operator-drive-mode` FAILS (today `this.namespace = deps.namespace ?? 'default'` never undefined; guards reject; group is bare).
- [ ] **Step 5: Implement.**
  - `engine.ts:325`: `private readonly namespace: string | undefined;`
  - `engine.ts:395`: `this.namespace = deps.namespace;` (drop `?? 'default'`).
  - `engine.ts:399`: guard the transport call — `if (this.namespace !== undefined) { this.pool.useNamespace(this.namespace); }` (leave the transport on its constructor prefix — bare/shared — for an operator).
  - `engine.ts:926` (`resume`): change the throw guard to also require this engine is scoped — `if (this.namespace !== undefined && run.namespace !== undefined && run.namespace !== this.namespace)`.
  - `engine.ts:2742` (`completeRemoteDecision`): same — `if (this.namespace !== undefined && run.namespace !== undefined && run.namespace !== this.namespace) return;`.
  - `resolveRemoteByConvention` (1004-1020): compute `const group = tenantGroup(run.workflow, run.namespace);`, check `liveGroups.includes(group)`, `new RemoteWorkflowExecutor(this.pool.primary, group)`, and `remote: { group, executor }`. (Name stays `run.workflow`.)
- [ ] **Step 6: Verify pass** — `pnpm -C packages/core test operator-drive-mode tenant-group` PASS, then `pnpm -C packages/core test` (whole core suite green; the `?? 'default'` removal must not regress `namespace-engine.spec.ts` — a scoped engine still stamps + filters its namespace).
- [ ] **Step 7: Commit** — changeset `@dudousxd/nestjs-durable-core` minor; stage `packages/core/src/tenant-group.ts packages/core/src/engine.ts packages/core/src/operator-drive-mode.spec.ts packages/core/src/tenant-group.spec.ts .changeset/*.md`.

---

### Task P4C.2: TS worker — tenant identity + suffixed group + idempotent start-run

**Files:**
- Modify: `packages/worker/src/redis-runner.ts` (group registration + `startRun`), and the worker context/runner where `group` is chosen; `packages/worker/src/*` runner-core.
- Test: `packages/worker/src/tenant-worker.spec.ts` (create).

**Interfaces:**
- Consumes: `tenantGroup` from `@dudousxd/nestjs-durable-core`.
- Produces: worker accepts a `tenant?: string` distinct from the transport prefix; it registers its group as `tenantGroup(baseGroup, tenant)` and heartbeats under it (so an operator's `listWorkerGroups()` sees `<workflow>@<tenant>`). `startRun(connection, { tenant, workflow, input, runId?, tags? })` — when `runId` is omitted, document that redelivery is NOT idempotent; provide a stable-id path (accept caller `runId`; do not silently mint a fresh uuid per delivery inside a retryable consumer).

- [ ] **Step 1: Failing test** — a worker configured `{ tenant: 'davi-local', baseGroup: 'processing' }` registers/heartbeats group `processing@davi-local`; a worker with no tenant (or `'default'`) registers bare `processing`. `startRun` dispatches a `StartRunMessage` carrying `tenant: 'davi-local'` and the caller's `runId` verbatim (no uuid substitution at the transport layer).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — thread `tenant` through the worker/runner; group = `tenantGroup(baseGroup, tenant)`; keep the transport prefix independent (shared with the control plane). Ensure `startRun` passes `runId` through unchanged; the idempotency contract is the caller's `runId`.
- [ ] **Step 4: Verify** — `pnpm -C packages/worker test` green; no core regression.
- [ ] **Step 5: Commit** — changeset `@dudousxd/nestjs-durable-worker` minor.

---

### Task P4C.3: Python worker — tenant ≠ namespace + suffixed group + start_run idempotency

**Files:**
- Modify: `clients/python/durable_worker/worker.py` (Worker `tenant` attr; group registration; `start_run` message).
- Create: `clients/python/durable_worker/_tenant_group` helper (module-level function).
- Test: `clients/python/tests/test_tenant_worker.py` (create).

**Interfaces:**
- Produces: `Worker(..., tenant: str | None = None)`; `_tenant_group(base_group, tenant)` byte-identical to TS `tenantGroup` (suffix `@tenant` unless tenant is None/''/'default'). Group registration + heartbeat use `_tenant_group(base_group, self.tenant)`. `start_run(workflow, input, *, run_id, tags)` sends `{"tenant": self.tenant or self.namespace, ...}` — tenant now DECOUPLED from the wire prefix (which stays `self.namespace`/effective_prefix). Fixes review IMPORTANT #2.

- [ ] **Step 1: Failing test** — `_tenant_group("processing", "davi-local") == "processing@davi-local"`; `== "processing"` for None/""/"default". A `Worker(namespace="default", tenant="davi-local")` registers group `processing@davi-local` while its effective_prefix stays `durable` (shared) — i.e. tenant does NOT segment the wire. `start_run` message `tenant == "davi-local"`, `run_id` passed through (idempotency = caller's run_id; no per-call uuid inside a retryable path).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — add `tenant`; `_tenant_group`; use it for group/heartbeat; `start_run` tenant field decoupled from effective_prefix; run_id stable.
- [ ] **Step 4: Verify** — `pytest clients/python` green; `python -m py_compile` clean.
- [ ] **Step 5: Commit** — bump `durable_worker` pyproject + `__version__` minor.

---

### Task P4C.4: NestJS — `DurableControlPlaneModule` drives while `worker:false`

**Files:**
- Modify: `packages/nestjs/src/durable.module.ts` (option + `DurableControlPlaneModule` + `runDispatcher` selection), `packages/nestjs/src/timer-poller.ts` (:33 gate), `packages/nestjs/src/workflow.registrar.ts` (:52 gate); tenant option on `DurableWorkerModule` (group suffix via `tenantGroup`).
- Test: `packages/nestjs/src/control-plane-drive.spec.ts` (create) or extend existing module specs.

**Interfaces:**
- Produces: an internal `drive?: boolean` on `DurableModuleOptions` (defaults to `worker !== false` — back-compat). `DurableControlPlaneModule.forRoot/forRootAsync` set `{ worker: false, drive: true }`. `DurableWorkerModule` accepts `tenant?: string`, registering each discovered `@Workflow`'s group as `tenantGroup(name, tenant)`.
- Consumes: `tenantGroup` from core.

- [ ] **Step 1: Failing test** — a module built via `DurableControlPlaneModule.forRoot(...)`: (a) `TimerPoller` DOES start its poll loop (drive on) even though `worker === false`; (b) `WorkflowRegistrar` DOES run boot `recoverIncomplete`; (c) the engine's `runDispatcher` is NOT the `{dispatch:()=>{}}` no-op (so `runPending` dispatches — remotely, via `remoteByConvention`). Plus: a plain `DurableModule.forRoot({ worker: false })` (API pod) STILL has drive OFF + no-op dispatch (regression). Plus: `DurableWorkerModule` with `tenant:'t1'` registers discovered workflow `w` under group `w@t1`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — gate `TimerPoller`/`WorkflowRegistrar` boot on `options.drive` (default `worker !== false`); select `runDispatcher` no-op only when `worker === false && drive !== true`; `DurableControlPlaneModule` sets `worker:false, drive:true`; `DurableWorkerModule` threads `tenant` into group registration via `tenantGroup`.
- [ ] **Step 4: Verify** — full-workspace `pnpm build && pnpm typecheck && pnpm test` green (tsup DTS is stricter than tsc — the WHOLE build must pass, not just `-C packages/nestjs test`).
- [ ] **Step 5: Commit** — changeset `@dudousxd/nestjs-durable` minor.

---

### Task P4C.5: Cross-SDK operator↔tenant e2e (redis-gated, written not run)

**Files:**
- Create: `packages/*/test/e2e/operator-tenant.e2e.spec.ts` (or the repo's existing docker-compose e2e location) — mark redis-gated (skip when no `REDIS_URL`).

**Interfaces:** Consumes the shipped operator + tenant-group + control-plane-drive surfaces.

- [ ] **Step 1: Write the e2e** — operator engine (`namespace: undefined`, `remoteByConvention: true`, control-plane drive) on shared prefix; a tenant worker (`tenant: 't1'`, group `w@t1`) on the SAME prefix; tenant `start_run` → operator stamps `namespace: 't1'` → operator dispatches to `w@t1` → tenant executes → decision returns on the shared prefix → operator marks complete; assert the run is `completed` and stamped `t1`; assert operator can `cancel`/recover it (drive path). Gate on `REDIS_URL`.
- [ ] **Step 2: Commit** — no version bump (test only). Note in the ledger that CI/local-redis execution is the remaining gate.
