# Durable Unified Module + Convention-Default + Alias Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Collapse the four role-declaration shapes (`DurableModule`, `DurableWorkerModule`, `DurableControlPlaneModule`, `inAppWorker` option) into one `DurableModule.forRoot` with role inferred from inputs; make convention-dispatch the default (drop `remoteByConvention`); and delete every Phase-1 deprecation alias (`ctx.call`, `remoteStep({group})`, module `groups`/`tenant`/`concurrencyByGroup`, `BullMQTransport({group})`, Python `Worker(group=/tenant=)`).

**Architecture:** Role is inferred: `store` ⇒ operator (engine + store + drivers), `connection` (no store) ⇒ thin worker (`DurableStartClient` + `ProxyRunGateway` + per-name `runRedisWorker`), `store + connection` ⇒ operator that dispatches its own bodies to a co-located per-name worker (the old `inAppWorker`). `partition?` is the only isolation knob; `drive?` (default true for an operator) stays for read-only store replicas. Convention dispatch (no local body + live worker of that name → dispatch) is unconditional. Breaking at 0.x; downstream (flip/squid/Python) adopts wholesale.

**Tech Stack:** TypeScript (pnpm+turbo+tsup, `exactOptionalPropertyTypes`), Vitest, Biome 1.9.4, changesets; Python `durable-worker`.

**Spec:** `docs/superpowers/specs/2026-07-02-durable-unified-module-design.md`. Builds on Phase 1 (`...-execution-redesign-design.md`), shipped beta `0.0.0-beta-20260702190022`.

## Global Constraints

- Same as Phase 1: `pnpm test` (root vitest) is the suite; single file `pnpm vitest run <path>`; DB `pnpm test:db`. CI gate `pnpm lint`(`biome check .`)→`typecheck`→`build`→`test`. Biome: single quotes, width 100, trailing commas all, semicolons. `exactOptionalPropertyTypes` on (`x?: T | undefined`, conditional spread, never assign `undefined`). `noUncheckedIndexedAccess` on.
- **Fresh-dist rule (Phase-1 lesson):** cross-package typecheck must run against freshly built dep dists — after a core change, `pnpm --filter <core> build` THEN typecheck downstream, or run `pnpm typecheck` (turbo `^build`) for the authoritative check. Individual-package typecheck against stale dist masks breaks.
- **This is a BREAKING cut** — deleted aliases must be GONE (no shim), and any in-repo/test usage migrated to the canonical name in the same task.
- Package names for changesets (all `minor`, 0.x-breaking): `@dudousxd/nestjs-durable-core`, `@dudousxd/nestjs-durable`, `@dudousxd/nestjs-durable-transport-bullmq`, `@dudousxd/durable-worker`.
- `tenantGroup`/`sanitizeQueueToken` (`core/src/tenant-group.ts`) are the shared token builders — reuse, never fork.
- No `Co-Authored-By`. `function foo()`. Explicit `git add` paths. Commit locally; do NOT push/publish (orchestrator handles the beta).

---

### Task 1: core — convention dispatch as default; delete `ctx.call` + `remoteStep({group})`

**Files:**
- Modify: `packages/core/src/engine.ts` (`resolveRemoteByConvention` :1023-1042; the `remoteByConvention` option field + its read; `knownGroups` unaffected)
- Modify: `packages/core/src/interfaces.ts` (`WorkflowCtx.call` — delete; engine options `remoteByConvention` — delete)
- Modify: `packages/core/src/workflow-ctx.ts` (the `call:` key in the ctx literal — delete; keep `remote`)
- Modify: `packages/core/src/remote-step-factory.ts` (delete `group` from `RemoteStepConfig` + its mapping; keep `partition`)
- Test: `packages/core/src/remote-step-factory.spec.ts`, `packages/core/src/workflow-ctx.spec.ts`, plus any engine convention spec

**Interfaces:**
- Produces: `resolveRemoteByConvention` runs unconditionally (no `this.remoteByConvention` guard). `WorkflowCtx` has only `remote` (no `call`). `remoteStep({ name, input, output, partition? })` — no `group` accepted.
- Consumes: `sanitizeQueueToken`/`tenantGroup` (unchanged).

- [ ] **Step 1: Update tests first.** In `remote-step-factory.spec.ts`, delete the `group`-alias cases; assert `remoteStep({ name:'x', group:'g' })` is now a TYPE error (remove that case or convert to a `// @ts-expect-error` fixture). In `workflow-ctx.spec.ts`, delete the `ctx.call` assertion (keep `ctx.remote`). Add/keep an engine convention test proving dispatch-to-remote happens with NO flag (mirror `packages/nestjs/src/remote-by-convention-module.spec.ts` but at whatever core-level harness exists; if convention is only covered at the nestjs level, leave that to Task 2 and just remove the flag here).
- [ ] **Step 2: Run, expect failures** referencing the removed symbols. `pnpm vitest run packages/core`
- [ ] **Step 3: Implement.** In `engine.ts`, delete the `remoteByConvention?` option field from the engine deps/options type and the `if (!this.remoteByConvention) return undefined;` guard at the top of `resolveRemoteByConvention` (`:1026`) so it always attempts convention resolution (the rest — `listWorkerGroups()`, the sanitized membership check from the Phase-1 fix, the throwaway `RegisteredWorkflow` — is unchanged). Delete `WorkflowCtx.call` (`interfaces.ts`) and the `call:` key in `workflow-ctx.ts` (keep the `remote` closure). In `remote-step-factory.ts`, delete `group` from `RemoteStepConfig`, the `console.warn`, and the `partition ?? group` fallback — `partition` only.
- [ ] **Step 4: Run core suite green.** `pnpm vitest run packages/core`. Grep the repo for any remaining `remoteByConvention`, `ctx.call(`, `remoteStep({` with `group` and fix in-repo usages (non-nestjs; nestjs handled in Task 2).
- [ ] **Step 5: Rebuild + downstream typecheck + commit.** `pnpm --filter @dudousxd/nestjs-durable-core build && pnpm typecheck` (authoritative — will surface downstream `remoteByConvention`/`call` usages; note them for Task 2/3/4 if in those packages, but core+transport+worker must compile — fix any in core/transport/worker here). Commit core files + specs.

---

### Task 2: nestjs — unified `DurableModule.forRoot` (role inferred); delete worker/control-plane/inApp shapes + flag + aliases

This is the large task. It merges `durable-worker.module.ts` and the `inAppWorker` mechanics into `durable.module.ts`, and removes `DurableControlPlaneModule`.

**Files:**
- Modify: `packages/nestjs/src/durable.module.ts` (options + `build`; delete `worker`/`remoteByConvention`/`inAppWorker` options; add `connection?`/`partition?`; role-branch the provider assembly; delete `DurableControlPlaneModule`)
- Modify/absorb: `packages/nestjs/src/durable-worker.module.ts` (its `build()` provider set — thin-worker branch — moves into `durable.module.ts`; DELETE the `DurableWorkerModule` class/exports)
- Modify/absorb: `packages/nestjs/src/in-app-worker.ts` (its providers become the `store + connection` branch, reading TOP-LEVEL `connection`/`partition` instead of `options.inAppWorker.*`; delete `DurableInAppWorkerOptions`/`inAppWorker` nesting)
- Modify: `packages/nestjs/src/index.ts` (drop exports of `DurableWorkerModule`, `DurableControlPlaneModule`, `DurableInAppWorkerOptions`; keep `DurableModule`)
- Modify: `packages/nestjs/src/durable-worker.module.ts` consumers of `DURABLE_WORKER_OPTIONS`/`RUN_REDIS_WORKER`/`ThinWorkerBootstrap`/`Thin*Registrar` (these move; keep the classes, re-home them)
- Test: `durable-worker.module.spec.ts` (rewrite as `DurableModule` `{connection}` cases), `remote-by-convention-module.spec.ts` (drop the flag), `in-app-worker.spec.ts` (rewrite as `{store,transport,connection}`), `durable-start-client.spec.ts`, `tenant-dashboard.module.spec.ts`, plus a new `durable-module-inference.spec.ts`

**Role inference (the core contract):**
```
forRoot(options):
  hasStore = options.store !== undefined
  hasConn  = options.connection !== undefined
  if (!hasStore && !hasConn) throw "a durable module needs either `store` (operator) or `connection` (worker)"
  if (hasStore && options.transport === undefined) throw "an operator (`store`) needs a `transport`"
  operator branch  (hasStore):  current DurableModule providers (engine + StoreRunGateway + drivers + retention + WorkflowRegistrar/DurableStepRegistrar), driven by `drive?` (default true)
  co-located worker (hasStore && hasConn): ALSO register bodies group-served + start a co-located runRedisWorker (current inAppWorker mechanics, reading top-level connection/partition)
  thin-worker branch (hasConn && !hasStore): current DurableWorkerModule providers (DurableStartClient under WorkflowEngine, ProxyRunGateway, DurableWorkerRuntime, RUN_REDIS_WORKER, Thin*Registrar, ThinWorkerBootstrap) — NO store/transport-canonical/timer/retention/entity/responder
```
Shared tokens each branch must bind exactly once: `WorkflowEngine`, `RUN_GATEWAY`, `WorkflowService`.

**Options after (delete `worker`, `remoteByConvention`, `inAppWorker`, and the Phase-1 deprecated `groups`/`tenant`/`concurrencyByGroup`):**
`{ store?, transport?, connection?, partition?, drive?, prefix?, instanceId?, namespace?, ...operator-only tuning (leaseMs/timerPollMs/retention/schedules/queues/admission/etc.), concurrency?, concurrencyByHandler?, runGatewayTimeoutMs? }`.

- [ ] **Step 1: Write inference tests first.** New `durable-module-inference.spec.ts`: `forRoot({ store, transport })` → resolves real `WorkflowEngine` (not `DurableStartClient`), `RUN_GATEWAY` is `StoreRunGateway`, no `runRedisWorker` call. `forRoot({ connection })` (fake `RUN_REDIS_WORKER`) → `WorkflowEngine` resolves to a `DurableStartClient` (its `cancel` rejects "not available on a tenant worker"), `RUN_GATEWAY` is `ProxyRunGateway` when `transport` given, exactly one `runRedisWorker` call carrying `partition`, NO store. `forRoot({ store, transport, connection })` → real engine + one co-located `runRedisWorker` + `knownGroups()` lists each `@Workflow`'s per-name token. `forRoot({})` and `forRoot({ store })` (no transport) throw the exact messages.
- [ ] **Step 2: Run, expect failures.** `pnpm vitest run packages/nestjs/src/durable-module-inference.spec.ts`
- [ ] **Step 3: Implement the merge.** Move the thin-worker `build()` provider set from `durable-worker.module.ts` into a helper (e.g. `thinWorkerProviders(optionsToken)`) and the operator set stays; `DurableModule.build` picks the set by role. Re-home `ThinWorkflowRegistrar`/`ThinStepRegistrar`/`ThinWorkerBootstrap`/`DurableStartClient` wiring under the unified module (keep the classes/files; just stop exporting a separate module). Rework `in-app-worker.ts` so `inAppWorkerBinding` + `IN_APP_WORKER_RUNTIME` + `InAppWorkerBootstrap` read top-level `connection`/`partition` from `DURABLE_OPTIONS_CANONICAL` (delete `DurableInAppWorkerOptions` and the `inAppWorker` nesting), and are active whenever `store && connection`. Delete `DurableControlPlaneModule` and `DurableWorkerModule` classes + their exports. Delete `remoteByConvention`/`worker`/`inAppWorker`/`groups`/`tenant`/`concurrencyByGroup` option fields. Keep `drive?` (default true when `store`); when `drive===false` install the no-op dispatcher AND skip pollers/recovery (fold the old `worker:false` no-op-dispatcher case into `drive:false`).
- [ ] **Step 4: Migrate + green all nestjs specs.** Rewrite `durable-worker.module.spec.ts` → `DurableModule` `{connection}` cases; drop the flag from `remote-by-convention-module.spec.ts`; rewrite `in-app-worker.spec.ts` → `{store,transport,connection}`; fix `durable-start-client.spec.ts`/`tenant-dashboard.module.spec.ts` imports. `pnpm vitest run packages/nestjs` green.
- [ ] **Step 5: Fresh-dist typecheck + commit.** `pnpm --filter @dudousxd/nestjs-durable-core build && pnpm --filter @dudousxd/durable-worker build && pnpm --filter @dudousxd/nestjs-durable typecheck` clean. Grep `packages/nestjs` for any lingering `DurableWorkerModule`/`DurableControlPlaneModule`/`inAppWorker`/`remoteByConvention` and fix. Commit.

---

### Task 3: transport-bullmq — delete `group` option alias

**Files:** `packages/transport-bullmq/src/bullmq-transport.ts` (`BullMQTransportOptions.group` + its `?? this.partition` mapping); specs using `{ group: ... }`.

- [ ] **Step 1:** In the transport spec(s), change any `new BullMQTransport({ group: 'x' })` to `{ partition: 'x' }` and assert `group` is now a type error (or remove).
- [ ] **Step 2:** Run, expect failures. `pnpm vitest run packages/transport-bullmq`
- [ ] **Step 3:** Delete `group?` from `BullMQTransportOptions` and the constructor line mapping `group`→`partition`. `partition?` only.
- [ ] **Step 4:** `pnpm vitest run packages/transport-bullmq` green; DB spec if Docker (`pnpm vitest run --config vitest.db.config.ts packages/transport-bullmq/src/bullmq-transport.db.spec.ts`).
- [ ] **Step 5:** `pnpm --filter @dudousxd/nestjs-durable-core build && pnpm --filter @dudousxd/nestjs-durable-transport-bullmq typecheck` clean. Commit.

---

### Task 4: worker — delete `group`/`tenant` option aliases

**Files:** `packages/worker/src/redis-runner.ts` (`RunRedisWorkerOptions.group`/`tenant` + their handling, `:230-236` area); specs.

- [ ] **Step 1:** In `redis-runner.spec.ts`/`tenant-worker.spec.ts`, change `runRedisWorker({ group })`/`{ tenant }` to `{ partition }`; assert the old keys are type errors.
- [ ] **Step 2:** Run, expect failures. `pnpm vitest run packages/worker`
- [ ] **Step 3:** Delete `group?`/`tenant?` from `RunRedisWorkerOptions` and the deprecation warnings/mapping; `partition?` only.
- [ ] **Step 4:** `pnpm vitest run packages/worker` green.
- [ ] **Step 5:** `pnpm --filter @dudousxd/nestjs-durable-core build && pnpm --filter @dudousxd/durable-worker typecheck` clean. Commit.

---

### Task 5: Python — delete `Worker(group=/tenant=)` + `run_redis_worker` aliases; bump version

**Files:** `clients/python/durable_worker/worker.py` (`Worker.__init__` — remove `group=`/`tenant=` params + warns; `partition=` only), `clients/python/durable_worker/redis_runner.py` (any `group`/`tenant` alias handling), `clients/python/durable_worker/__init__.py` + `pyproject.toml` (bump `0.20.0b0` → `0.21.0b0`); tests.

- [ ] **Step 1:** Update tests: `Worker(partition=...)` only; assert `Worker(tenant=...)`/`Worker(group=...)` now raise `TypeError` (removed kwargs) — adjust the tenant/deprecation tests accordingly.
- [ ] **Step 2:** Run, expect failures. `cd clients/python && python3 -m pytest -q`
- [ ] **Step 3:** Remove `group=`/`tenant=` kwargs + their `warnings.warn` from `Worker.__init__` and `run_redis_worker`; keep `partition`. Bump version in both files.
- [ ] **Step 4:** `cd clients/python && python3 -m pytest -q` green; `ruff` clean.
- [ ] **Step 5:** Commit.

---

### Task 6: Changeset

**Files:** `.changeset/durable-unified-module.md`.

- [ ] **Step 1:** Write the changeset: `minor` for all four JS packages; body summarizes the unified `DurableModule` (role inferred from `store`/`connection`), convention-default (flag removed), and the deprecation-alias removals — note it's a breaking 0.x cut and the fleet adopts together. Python bumped to `0.21.0b0`.
- [ ] **Step 2:** `pnpm changeset status` lists the four at minor. `pnpm lint && pnpm typecheck && pnpm test` full gate green. Commit.

---

## Self-Review

- **Spec coverage:** unified module → T2; convention-default → T1 (engine) + T2 (module option removal); alias removal → T1 (ctx.call/remoteStep) + T2 (module opts) + T3 (transport) + T4 (worker) + T5 (python); changeset → T6.
- **Sequencing:** T1 (core) first — downstream typechecks then see the removed symbols; T2 is the big merge (depends on T1's convention change); T3/T4/T5 are independent alias deletions (T3/T4/T5 can run in parallel after T1; T5 is disjoint Python). T2 must land before the nestjs specs referencing old modules compile.
- **Type consistency:** `partition` is the single isolation field everywhere; `drive?` optional operator axis; role inference keys off `store`/`connection` presence.
- **Fresh-dist typecheck is mandatory each task** (Phase-1 lesson — stale core dist masked a worker break).
- **Breaking-cut discipline:** each task migrates its own in-repo/test usages of the deleted alias in the same commit, so the repo stays green.
