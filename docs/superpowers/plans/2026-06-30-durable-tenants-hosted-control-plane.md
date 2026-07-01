# Durable Tenants & Hosted Control Plane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let apps use one shared durable control plane as tenants — declaring a tenant identity, running only workers over the transport, never touching the database — and delete the per-workflow `engine.remote(...)` registration boilerplate.

**Architecture:** Four independent, individually-shippable increments on the existing engine. (P2) generic routing resolves an unregistered remote workflow to the live worker group of the same name, deleting flip's `ProcessingWorkflowRegistrar`. (SCOPE) a MikroORM global filter makes namespace a uniform read boundary. (P1) the already-existing `DurableWorkerModule` / `worker:false` split gets blessed as the tenant/control-plane packaging. (P4) a start-run transport message lets a DB-less worker start a run through the control plane.

**Tech Stack:** TypeScript (pnpm+turbo monorepo, vitest, tsup, biome, changesets), MikroORM 7, BullMQ/Redis transport, Python SDK (`clients/python/durable_worker`).

## Global Constraints

- Node/TS monorepo: `function` declarations not arrow consts; descriptive names; no `as`/`any`/`unknown`/`never` — use type guards / discriminated unions; `node:crypto` for hashing; add no new deps.
- Every package change ships a changeset (`.changeset/*.md`); bump MINOR for new behavior/options, PATCH for internal-only. Releases are via changesets/CI on merge to `main` — **do not publish by hand**.
- Full gate green per touched package: `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint` (`biome check`). Run `biome format --write` on changed files.
- Backward compatible: `namespace` default stays `"default"`; `"default"` must remain byte-identical on the wire; existing `engine.remote()`/`registerRemote()`/`DurableModule` keep working (nothing is removed from the lib — only flip stops *needing* the registrar).
- NO Co-Authored-By in commits. Stage explicit paths (never `git add -A`).
- Package name→dir map: core=`packages/core` (`@dudousxd/nestjs-durable-core` 0.45.0), nestjs=`packages/nestjs` (`@dudousxd/nestjs-durable` 0.26.0), store=`packages/store-mikro-orm` (0.16.2), transport=`packages/transport-bullmq` (0.11.0), worker=`packages/worker` (`@dudousxd/durable-worker` 0.5.0), python=`clients/python/durable_worker` (PyPI `durable-worker` 0.17.0).

---

## File structure (what changes, by increment)

**P2 — generic routing (core + tests):**
- Modify: `packages/core/src/engine.ts` — route resolution in `execute` (`:1738-1740`) + `start` (`:800-808`); a new `resolveRemoteByConvention(run)` helper; a new option `remoteByConvention?: boolean | 'auto'` on `WorkflowEngineDeps`.
- Test: `packages/core/src/remote-by-convention.spec.ts` (new).

**SCOPE — tenant read filter (store + core interface):**
- Modify: `packages/store-mikro-orm/src/entities.ts` — add a `namespace` filter to each `EntitySchema`.
- Modify: `packages/store-mikro-orm/src/mikro-orm-state-store.ts` — enable/parameterise the filter at each `this.orm.em.fork()`, driven by a constructor `scope?: { namespace?: string }`.
- Test: `packages/store-mikro-orm/src/tenant-scope.spec.ts` (new).

**P1 — module blessing (nestjs + docs):**
- Modify: `packages/nestjs/src/durable.module.ts` — export `DurableControlPlaneModule` as a named factory over the existing `worker:false` path.
- Modify: `packages/nestjs/src/index.ts` — re-export.
- Docs: README section clarifying control-plane vs `DurableWorkerModule` (worker/tenant).

**P4 — start-run over the protocol (core + transport + worker + python):**
- Modify: `packages/core/src/interfaces.ts` — `dispatchStartRun?`/`onStartRun?` on `Transport`; `StartRunMessage` type.
- Modify: `packages/transport-bullmq/src/bullmq-transport.ts` — a `<prefix>-start-run` queue producer+consumer, namespace-prefixed.
- Modify: `packages/core/src/engine.ts` — control-plane wires `transport.onStartRun(msg => this.start(msg.workflow, msg.input, undefined, { namespace: msg.tenant }))`.
- Modify: `packages/core/src/engine.ts` `start()` (`:793-858`) — accept `opts.namespace` to override the stamp (today it stamps `this.namespace` at `:840`).
- Modify: `packages/worker/src/redis-runner.ts` + `packages/nestjs/src/durable-worker.module.ts` — a `startRun(tenant, workflow, input)` client on the worker runtime.
- Modify: `clients/python/durable_worker/worker.py` + `redis_runner.py` — `Worker.start_run(workflow, input)` publishing the same message.
- Tests: `packages/core/src/start-run-protocol.spec.ts`, a cross-SDK docker test, python `tests/test_start_run.py`.

**flip adoption (separate repos, after the relevant increment):**
- `flip-nestjs`: delete `src/durable/processing-workflow.registrar.ts` (after P2); no other change required — flip is the control plane and *wants* the unscoped operator view, so SCOPE's filter stays off for flip.
- `flip-python-db`: unchanged for P2/SCOPE; adopts `start_run` only if it ever needs to start runs itself (today flip-nestjs starts them).

**Recommended order:** P2 (registrar killer, independent, highest-wanted) → SCOPE (uniform boundary) → P1 (naming, trivial) → P4 (largest, enables autonomous tenants). Each is independently shippable; a reviewer can approve/reject one without the others.

---

## Increment P2 — Generic routing (delete the registrar)

### Task P2.1: Convention route resolver in the engine

**Files:**
- Modify: `packages/core/src/engine.ts` (route resolution `:1738-1740`; `start` `:800-808`; deps type near `:300-380`)
- Test: `packages/core/src/remote-by-convention.spec.ts` (create)

**Interfaces:**
- Consumes: `this.workflows: Map<string, RegisteredWorkflow>` (`engine.ts:327`), `this.pool.listWorkerGroups(): Promise<string[]>` (live groups), `RemoteWorkflowExecutor` (`remote-workflow-executor.ts:29`), `synthesizeRemoteChild` pattern (`engine.ts:927-944`).
- Produces: `private async resolveRemoteByConvention(run: WorkflowRun): Promise<RegisteredWorkflow | undefined>` — returns a synthesized remote `RegisteredWorkflow` routing to `group = run.workflow` on `this.pool.primary`, or `undefined`. New deps flag `remoteByConvention?: boolean` (default `false`; flip sets `true`).

- [ ] **Step 1: Write the failing test** — an engine with no registration for workflow `"processing"`, `remoteByConvention: true`, and a fake transport reporting group `"processing"` live, dispatches a pending `processing` run to group `"processing"`.

```ts
// remote-by-convention.spec.ts
it('routes an unregistered workflow to the live group of the same name', async () => {
  const dispatched: string[] = [];
  const transport = makeFakeTransport({
    listWorkerGroups: async () => ['processing'],
    dispatchWorkflowTask: async (t) => { dispatched.push(t.group); },
  });
  const engine = new WorkflowEngine({ store, transport, namespace: 'default', remoteByConvention: true });
  const run = await engine.start('processing', { hello: 'world' }); // never registered locally
  await engine.runOne(run.id);
  expect(dispatched).toEqual(['processing']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C packages/core test remote-by-convention`
Expected: FAIL — today `execute` throws "workflow not registered" because `this.workflows.get(key)` is undefined and no inherited ancestor exists.

- [ ] **Step 3: Implement the resolver + wire it into route resolution**

Add the deps flag (near the `WorkflowEngineDeps` destructure ~`:360-377`): `this.remoteByConvention = deps.remoteByConvention ?? false;`. Add the helper:

```ts
private async resolveRemoteByConvention(run: WorkflowRun): Promise<RegisteredWorkflow | undefined> {
  if (!this.remoteByConvention) return undefined;
  const liveGroups = await this.pool.listWorkerGroups();
  if (!liveGroups.includes(run.workflow)) return undefined;
  const executor = new RemoteWorkflowExecutor(this.pool.primary, run.workflow);
  // Mirror synthesizeRemoteChild: a throwaway registration carrying only the remote route.
  return {
    name: run.workflow,
    version: run.workflowVersion,
    fn: () => { throw new Error(`remote workflow ${run.workflow} has no local body`); },
    hasBody: false,
    remote: { group: run.workflow, executor },
  } as RegisteredWorkflow;
}
```

Then extend BOTH lookups. `execute` (`:1738-1740`):

```ts
const registered =
  this.workflows.get(versionKey(run.workflow, run.workflowVersion)) ??
  (await this.findInheritedRegistration(run)) ??
  (await this.resolveRemoteByConvention(run));
```

`start` (`:800-808`) mirrors it so a first-time `start` of an unregistered-but-live workflow doesn't throw (resolve `latest` → convention fallback before the "not registered" error). Keep the existing "not registered" throw as the final fallback when convention is off or the group isn't live.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/core test remote-by-convention`
Expected: PASS. Then `pnpm -C packages/core test` — the existing `remote-child-inherit.spec.ts` and dispatch specs stay green (convention is additive, gated behind the flag, only consulted after the registry + inheritance miss).

- [ ] **Step 5: Typecheck + lint + changeset + commit**

```bash
pnpm -C packages/core typecheck && pnpm -C packages/core lint
# .changeset/remote-by-convention.md  → "@dudousxd/nestjs-durable-core": minor
git add packages/core/src/engine.ts packages/core/src/remote-by-convention.spec.ts .changeset/remote-by-convention.md
git commit -m "feat(core): route unregistered workflows to the live group of the same name (remoteByConvention)"
```

### Task P2.2: Surface the flag through the NestJS module

**Files:**
- Modify: `packages/nestjs/src/durable.module.ts` (options `:132-264`; engine factory `:307-370`)
- Test: `packages/nestjs/test/remote-by-convention.e2e-spec.ts` (create) — assert the option threads into the engine.

- [ ] **Step 1: Failing test** — a `DurableModule.forRoot({ store, transport, remoteByConvention: true })` yields a `WorkflowEngine` whose convention routing is active (dispatch an unregistered workflow to a fake live group; assert dispatch).
- [ ] **Step 2: Verify fail** (`remoteByConvention` not in `DurableModuleOptions`).
- [ ] **Step 3: Add `remoteByConvention?: boolean` to `DurableModuleOptions` (`:132-264`) and forward it in the engine factory `new WorkflowEngine({ ..., remoteByConvention: opts.remoteByConvention })` (`:307-370`).**
- [ ] **Step 4: Verify pass** + `pnpm -C packages/nestjs test`.
- [ ] **Step 5: changeset (`@dudousxd/nestjs-durable`: minor) + commit** (`packages/nestjs/src/durable.module.ts`, the test, changeset).

### Task P2.3: flip adoption — delete the registrar

**Files (repo `/home/dudousxd/goflipai/flip-nestjs`):**
- Modify: `src/durable/durable-orchestrator.module.ts` — add `remoteByConvention: true` to the `DurableModule.forRootAsync` options; remove the `ProcessingWorkflowRegistrar` provider.
- Delete: the `ProcessingWorkflowRegistrar` file (search: `grep -rl ProcessingWorkflowRegistrar src`).
- Bump: `@dudousxd/nestjs-durable-core` + `@dudousxd/nestjs-durable` to the P2 versions in `package.json`.

- [ ] **Step 1:** Read `durable-orchestrator.module.ts`; confirm the `processing` group name equals the workflow name `"processing"` (the convention precondition). Confirm via the Python worker: group `"processing"`, `@worker.workflow("processing")`.
- [ ] **Step 2:** Bump the two deps, `pnpm install`.
- [ ] **Step 3:** Add `remoteByConvention: true`; delete the registrar provider + file.
- [ ] **Step 4:** `pnpm build` (nest build) exit 0; boot smoke (or a targeted unit) proving a `processing` run still dispatches to the Python worker's group with no registrar. Verify on dev after deploy: a pipeline run's child `processing` reaches the worker (dashboard shows the group served).
- [ ] **Step 5:** Commit `package.json`, `pnpm-lock.yaml`, `durable-orchestrator.module.ts`, and the registrar deletion. **Do not push until Davi confirms** (per repo norms).

---

## Increment SCOPE — Tenant read boundary (MikroORM global filter)

### Task SCOPE.1: Namespace filter on the durable entities

**Files:**
- Modify: `packages/store-mikro-orm/src/entities.ts` (`durableEntities` schemas `:107-224`)
- Modify: `packages/store-mikro-orm/src/mikro-orm-state-store.ts` (constructor `:60`; every `this.orm.em.fork()`)
- Test: `packages/store-mikro-orm/src/tenant-scope.spec.ts` (create; real in-memory sqlite ORM as the existing specs do)

**Interfaces:**
- Consumes: `MikroOrmStateStore` per-op `this.orm.em.fork()` (the choke points, e.g. `:67,96,188,197,207,247`), `WorkflowRunEntity.namespace` (`entities.ts:48,147`).
- Produces: `new MikroOrmStateStore(orm, { scope?: { namespace?: string } })` — when `scope.namespace` is set, every fork enables a global filter `namespace` bound to it; when unset (control plane / operator), the filter is disabled and all namespaces are visible.

- [ ] **Step 1: Failing test** — seed runs in namespaces `a` and `b`; a store scoped to `a` returns only `a`'s runs from `listRuns`/`getRun`, and `getRun` of a `b` run returns null; an unscoped store returns both.

```ts
it('a namespace-scoped store cannot read another namespace', async () => {
  await seedRun({ id: 'r-a', namespace: 'a' });
  await seedRun({ id: 'r-b', namespace: 'b' });
  const scoped = new MikroOrmStateStore(orm, { scope: { namespace: 'a' } });
  expect(await scoped.getRun('r-b')).toBeNull();
  expect((await scoped.listRuns({})).items.map(r => r.id)).toEqual(['r-a']);
  const operator = new MikroOrmStateStore(orm); // unscoped
  expect((await operator.listRuns({})).items.length).toBe(2);
});
```

- [ ] **Step 2: Verify fail** — today an unscoped fork sees both regardless.
- [ ] **Step 3: Implement.** In `entities.ts`, add to each schema (at least `WorkflowRunEntity`, and the child/step tables that carry `namespace`) a filter:

```ts
filters: {
  namespace: {
    cond: (args: { namespace?: string }) =>
      args.namespace === undefined ? {} : { [col('namespace')]: args.namespace },
    default: true,
  },
},
```

In `mikro-orm-state-store.ts`, capture `this.scopeNamespace = opts?.scope?.namespace` and centralise fork creation:

```ts
private fork() {
  const em = this.orm.em.fork();
  em.setFilterParams('namespace', { namespace: this.scopeNamespace });
  return em;
}
```

Replace every `this.orm.em.fork()` with `this.fork()`. When `scopeNamespace` is undefined the `cond` returns `{}` → no restriction (operator).

- [ ] **Step 4: Verify pass** + `pnpm -C packages/store-mikro-orm test` (existing schema-gate + resilience specs stay green — the filter defaults to no-op when unscoped, which is how the engine/control plane uses it today).
- [ ] **Step 5: typecheck + lint + changeset (`@dudousxd/nestjs-durable-store-mikro-orm`: minor) + commit.**

### Task SCOPE.2: Wire the scope from the NestJS module (opt-in)

**Files:**
- Modify: `packages/nestjs/src/durable.module.ts` — when `options.namespace` is set AND a new `options.scopeReads?: boolean` is true, construct the store with `{ scope: { namespace: options.namespace } }`. Default `scopeReads: false` so the control plane (flip) stays unscoped/operator.

- [ ] Steps mirror P2.2: failing test (a module with `namespace:'a', scopeReads:true` yields a store that can't read `b`), implement the wiring, verify, changeset, commit. **flip does NOT set `scopeReads`** (it's the operator) — so `/ctrl/pipeline-runs` keeps seeing all tenants; this option is for *tenant apps* that also happen to hold a store in the namespace topology.

---

## Increment P1 — Bless the control-plane / worker split (naming)

**Context:** the split already exists — `DurableWorkerModule` (`durable-worker.module.ts`, pure worker, no engine/store) and `DurableModule({ worker: false })` (dispatch/dashboard-only control plane). This increment only adds an intention-revealing name and docs; no behaviour change.

### Task P1.1: `DurableControlPlaneModule` named factory

**Files:**
- Modify: `packages/nestjs/src/durable.module.ts` — export `DurableControlPlaneModule` as a thin factory that calls `DurableModule.forRootAsync({ ...opts, worker: false })`.
- Modify: `packages/nestjs/src/index.ts` — re-export it.
- Test: `packages/nestjs/test/control-plane-module.e2e-spec.ts` — asserts it wires an engine with the no-op run dispatcher (i.e. `worker:false` semantics).

- [ ] Steps: failing test (module exists, engine has no-op run dispatcher) → implement the alias factory → verify → README paragraph (control plane vs `DurableWorkerModule` = tenant worker) → changeset (`@dudousxd/nestjs-durable`: minor) → commit.

---

## Increment P4 — Start-run over the protocol (autonomous tenant)

### Task P4.1: Transport start-run channel

**Files:**
- Modify: `packages/core/src/interfaces.ts` (`Transport` `:711-749`) — add `dispatchStartRun?(msg: StartRunMessage): Promise<void>` and `onStartRun?(handler: (msg: StartRunMessage) => Promise<void>): void`; define `StartRunMessage { tenant: string; workflow: string; input: unknown; runId?: string; tags?: string[] }`.
- Modify: `packages/transport-bullmq/src/bullmq-transport.ts` — a `<effectivePrefix>-start-run` queue: producer in `dispatchStartRun`, worker/consumer in `onStartRun`. Namespace-prefixed via `#effectivePrefix()` (`:182-190`).
- Test: `packages/transport-bullmq/src/start-run.spec.ts`.

- [ ] Steps: failing test (dispatchStartRun enqueues, onStartRun receives the same message) → implement producer/consumer mirroring the existing `tasks`/`results` queue plumbing (`bullmq-transport.ts`) → verify → changeset (`@dudousxd/nestjs-durable-core` + `-transport-bullmq`: minor) → commit.

### Task P4.2: Control plane consumes start-run → engine.start with the tenant's namespace

**Files:**
- Modify: `packages/core/src/engine.ts` — `start(name, input, runId?, opts?)` (`:793-858`): accept `opts.namespace` and stamp `namespace: opts?.namespace ?? this.namespace` at `:840` (today hardcoded `this.namespace`). In the engine constructor (control-plane side), if the transport has `onStartRun`, register `transport.onStartRun(async (m) => { await this.start(m.workflow, m.input, m.runId, { namespace: m.tenant, tags: m.tags }); })`.
- Test: `packages/core/src/start-run-protocol.spec.ts` — a start-run message for `{ tenant: 't1', workflow: 'processing', input }` creates a run stamped `namespace: 't1'`.

- [ ] Steps: failing test → implement the `opts.namespace` stamp override + the `onStartRun` wiring (guarded by capability check like `dispatchWorkflowTask`) → verify a run row lands with `namespace='t1'` → changeset → commit.

### Task P4.3: Worker SDK `startRun` client (TS + Python)

**Files:**
- Modify: `packages/worker/src/redis-runner.ts` — export `startRun(connection, { tenant, workflow, input, prefix? })` that publishes the `StartRunMessage` onto `<prefix>-start-run` (reusing `_effective_prefix` cross-SDK rule).
- Modify: `packages/nestjs/src/durable-worker.module.ts` — expose a `DurableStartRunClient` provider wrapping the above.
- Modify: `clients/python/durable_worker/worker.py` (`Worker` `:344`) + `redis_runner.py` — add `Worker.start_run(self, workflow, input, *, run_id=None, tags=None)` publishing the identical message onto `_effective_prefix(prefix, self.namespace) + '-start-run'`.
- Tests: `packages/worker/src/start-run-client.spec.ts`; `clients/python/tests/test_start_run.py`; extend the cross-language docker test so a Python worker calls `start_run` and a TS control plane creates the run stamped with the tenant.

- [ ] Steps per SDK: failing test (client publishes a well-formed message on the namespaced channel) → implement → verify → cross-SDK docker test (Python `start_run` → TS control plane creates `namespace=<tenant>` run → worker executes it) → changeset (`@dudousxd/durable-worker`: minor; Python `durable-worker`: minor) → commit.

---

## Self-review

**Spec coverage** (against `2026-06-30-durable-tenants-hosted-control-plane-design.md`):
- Module split → P1 (and the pre-existing `DurableWorkerModule`). ✓
- Generic routing `(namespace, workflow) → group`, deletes registrar → P2. ✓
- Start-run over protocol → P4. ✓
- Data-access scoping (global filter, "see-all = absence of namespace") → SCOPE (filter `cond` returns `{}` when namespace undefined = operator sees all; no `controlPlane` flag, matching the design). ✓
- flip dual role / `/ctrl` operator view → P2.3 note + SCOPE.2 note (flip stays unscoped). ✓
- Vocabulary (tenant app-facing, namespace internal) → surfaced as `tenant` on the wire (`StartRunMessage.tenant`) mapping to the internal `namespace` stamp in P4.2. ✓

**Placeholder scan:** no TBD/TODO; each core task carries real code; trivial tasks (P1.1, SCOPE.2, P2.2) reference the concrete option names + files rather than repeating boilerplate.

**Type consistency:** `resolveRemoteByConvention` returns `RegisteredWorkflow | undefined` (matches `execute`'s `?? `-chain); `StartRunMessage.tenant` (wire) → `engine.start(..., { namespace })` (internal) is the deliberate tenant→namespace mapping, consistent across P4.1/P4.2/P4.3; `scope.namespace` naming is identical in SCOPE.1 (store ctor) and SCOPE.2 (module wiring).

**Open design decisions carried into execution** (from the spec — resolve before/at the relevant task): tenant-id allocation (free string, adopted), trust boundary (internal/trusted, adopted), keep `namespace` as the internal column name (adopted — the wire says `tenant`, the column stays `namespace`).
