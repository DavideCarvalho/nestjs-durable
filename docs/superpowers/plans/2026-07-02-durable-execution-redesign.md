# Durable Execution Model + API Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local/remote step split's ceremony with `ctx.remote` (rename of `ctx.call`), route work by **handler name** instead of a declared `group`, expose `partition` as the optional isolation key, and lock the already-existing stateless-replay execution model — all delivered non-breaking via `@deprecated` source aliases.

**Architecture:** The wire format string `<prefix>-tasks-<token>` is UNCHANGED; only the token's meaning shifts from a declared group to `sanitize(handlerName)` with an optional `@<partition>` suffix (via the existing `tenantGroup` helper). Workers stop subscribing to one group queue and instead subscribe to one queue per *registered* `@Workflow`/`@Step` name (derived from the runtime registries). The stateless-replay-per-turn engine (`engine.ts:2467`) is documented + regression-locked, not changed. Deprecated aliases (`call`→`remote`, `group`→`partition`, `groups`→derived) keep every consumer's source compiling; the wire change is an atomic coordinated fleet deploy.

**Tech Stack:** TypeScript (pnpm + turbo + tsup, `exactOptionalPropertyTypes`), Vitest, Biome 1.9.4, changesets; Python `durable-worker` (`clients/python/`) mirrored for cross-SDK wire parity.

**Spec:** `docs/superpowers/specs/2026-07-02-durable-execution-redesign-design.md`

## Global Constraints

- **Test runner:** `pnpm test` = `vitest run` from repo root. Single file: `pnpm vitest run <path-from-root>`. `pnpm -r test` is a NO-OP (no per-package `test` script). DB tests: `pnpm test:db` (separate, testcontainers).
- **Typecheck one package:** `pnpm --filter <pkgname> typecheck`. CI gate order: `pnpm lint` (`biome check .`) → `pnpm typecheck` → `pnpm build` → `pnpm test`. All must pass.
- **Biome format:** 2-space indent, width 100, single quotes, trailing commas `all`, semicolons always.
- **`exactOptionalPropertyTypes: true`** — declare optionals as `partition?: string | undefined`; NEVER assign `{ partition: undefined }` — conditionally spread `...(partition !== undefined ? { partition } : {})`.
- **`noUncheckedIndexedAccess: true`** — indexed reads are `T | undefined`.
- **Cross-SDK wire contract:** the tasks-queue string is pinned identical across `bullmq-transport.ts:237`, `packages/worker/runner-core.ts:40`, and Python `clients/python/durable_worker/redis_runner.py:210`. Any change to how the queue token is built MUST change identically in all three.
- **Package names (verbatim, for changesets):** core `@dudousxd/nestjs-durable-core`, nestjs `@dudousxd/nestjs-durable`, transport `@dudousxd/nestjs-durable-transport-bullmq`, worker `@dudousxd/durable-worker`. All bumps `minor`.
- **Deprecation house style** (`decorators.ts:150`, `tokens.ts:16`): `@deprecated Use \`<new>\` instead. <old> is a back-compat alias of {@link New} and <why identical>. Removed in a future major.`
- **`tenantGroup(base, suffix)`** (`core/src/tenant-group.ts:9`) is the partition-suffixer: `undefined`/`''`/`'default'` → bare `base`; else `<base>@<suffix>`. Reuse it verbatim; do NOT fork the logic.
- No `Co-Authored-By`. `function foo()` over arrow consts. Stage explicit paths (no `git add -A`). Do NOT push or publish — commit locally only.

---

### Task 1: Core — `ctx.remote` as the primary name, `ctx.call` deprecated alias

**Files:**
- Modify: `packages/core/src/interfaces.ts` (`WorkflowCtx`, ~1076-1080)
- Modify: `packages/core/src/workflow-ctx.ts` (ctx assembly ~680-709)
- Test: `packages/core/src/workflow-ctx.spec.ts` (create if absent; else add cases)

**Interfaces:**
- Produces: `WorkflowCtx.remote<TInput, TOutput>(step, input, opts?)` — identical signature to today's `call`. `WorkflowCtx.call` retained, delegates to the same host seam, JSDoc `@deprecated`.
- Consumes: existing `host.callRemote` seam (`workflow-ctx.ts:80-88`, `:704`) — unchanged.

- [ ] **Step 1: Write the failing test.** In `workflow-ctx.spec.ts`, build a ctx with a fake `CtxHost` recording `callRemote` invocations. Assert `ctx.remote(def, input)` records exactly one dispatch with the def+input, AND `ctx.call(def, input)` records an identical dispatch (same seq semantics). A `remoteStep`-shaped def literal is fine.
- [ ] **Step 2: Run it, verify it fails** (`ctx.remote is not a function`): `pnpm vitest run packages/core/src/workflow-ctx.spec.ts`
- [ ] **Step 3: Implement.** In `interfaces.ts`, add a `remote<TInput, TOutput>(...)` method to `WorkflowCtx` with the exact signature currently on `call`; move the descriptive JSDoc to `remote`; change `call`'s JSDoc to the deprecation form pointing at `{@link WorkflowCtx.remote}`. In `workflow-ctx.ts`, in the ctx object literal (`:680-709`), add `remote:` bound to the same `host.callRemote(...)` closure currently under `call:`, and make `call:` delegate to the same closure (define the closure once, reference it from both keys).
- [ ] **Step 4: Run tests, verify pass.** `pnpm vitest run packages/core/src/workflow-ctx.spec.ts`
- [ ] **Step 5: Typecheck + commit.** `pnpm --filter @dudousxd/nestjs-durable-core typecheck` then `git add packages/core/src/interfaces.ts packages/core/src/workflow-ctx.ts packages/core/src/workflow-ctx.spec.ts && git commit -m "feat(core): add ctx.remote, deprecate ctx.call as alias"`

---

### Task 2: Core — `RemoteStepDef.partition` replaces `group`; factory + engine route by handler name

**Files:**
- Modify: `packages/core/src/interfaces.ts` (`RemoteStepDef` ~1000-1008; `RemoteTask`/`WorkflowTask` — search for `workerGroup`, the task interfaces around `:523/:573/:600/:634/:901/:915`)
- Modify: `packages/core/src/remote-step-factory.ts` (whole file, 25 lines)
- Modify: `packages/core/src/engine.ts` (6 read sites: `:2289, :2305, :2754, :2765, :2950, :2975`)
- Modify: `packages/core/src/remote-workflow-executor.ts` (`:42-63`, `this.group`)
- Test: `packages/core/src/remote-step-factory.spec.ts` (create if absent)

**Interfaces:**
- Produces: `RemoteStepDef { name; partition?: string | undefined; input; output; __remote }` (no `group`). `remoteStep({ name, input, output, partition? })`. Deprecated: `remoteStep({ group })` maps `group`→`partition` (one-time `console.warn`). The dispatched task's routing token = `tenantGroup(sanitizeQueueToken(step.name), step.partition)` — but keep it in the SAME task field the transport reads today (`group`/`workerGroup`) so the transport is untouched by this task. **Introduce `sanitizeQueueToken(name)` in `core/src/tenant-group.ts`** (or a sibling) = replace every `:` with `-` (BullMQ forbids `:`); export it. `.` is legal and left as-is.
- Consumes: `tenantGroup` (`tenant-group.ts:9`).

- [ ] **Step 1: Write the failing test.** In `remote-step-factory.spec.ts`: (a) `remoteStep({ name: 'a:b', input, output })` yields `{ name: 'a:b', partition: undefined-absent, __remote: true }` and NO `group` key; (b) `remoteStep({ name: 'x', partition: 't' })` carries `partition: 't'`; (c) `remoteStep({ name: 'x', group: 'g' })` yields `partition: 'g'` and calls `console.warn` once (spy). Add a `sanitizeQueueToken` unit test: `sanitizeQueueToken('extraction:page') === 'extraction-page'`, `sanitizeQueueToken('payments.charge') === 'payments.charge'`.
- [ ] **Step 2: Run it, verify it fails.** `pnpm vitest run packages/core/src/remote-step-factory.spec.ts`
- [ ] **Step 3: Implement.**
  - `tenant-group.ts`: add `export function sanitizeQueueToken(name: string): string { return name.replace(/:/g, '-'); }` with a JSDoc noting BullMQ forbids `:`.
  - `interfaces.ts` `RemoteStepDef`: replace `group: string` with `partition?: string | undefined` (JSDoc: "Optional isolation partition; routing is by `name`."). Update the `__remote` brand comment referencing `ctx.call`→`ctx.remote`.
  - `remote-step-factory.ts`: `RemoteStepConfig` gains `partition?: string`, keeps `group?: string` marked `@deprecated`. In the returned object, drop the `group: config.group ?? config.name.split('.')[0] ?? config.name` default; instead compute `partition = config.partition ?? config.group` and `if (config.group !== undefined) console.warn('remoteStep({group}) is deprecated; use {partition}')`; spread `...(partition !== undefined ? { partition } : {})`.
  - `engine.ts` 6 sites + `remote-workflow-executor.ts`: everywhere it currently reads `step.group` / `this.group` to fill the dispatch token or `workerGroup` checkpoint, replace with `tenantGroup(sanitizeQueueToken(step.name), step.partition)` (for steps) and for the workflow executor `tenantGroup(sanitizeQueueToken(this.workflowName), this.partition)` — the executor must now be constructed with the workflow NAME + partition instead of a raw group (update its constructor + the `registerRemote`/`resolveRemoteByConvention` call sites at `engine.ts:624/678/689-702/1038` to pass name+partition; note `resolveRemoteByConvention` at `:1028` already computes `tenantGroup(run.workflow, run.namespace)` — feed that workflow name + namespace through the new constructor shape). Keep writing the token into the existing task field the transport reads so no transport change is needed yet.
- [ ] **Step 4: Run the core suite, verify pass.** `pnpm vitest run packages/core` (routing-affecting specs: `gather-calls.spec.ts`, `remote-*`, any engine spec must stay green — a step with name `payments.charge-card` and no partition must dispatch to token `payments.charge-card`, which differs from the old `payments`; UPDATE those specs' expected tokens to the full sanitized name).
- [ ] **Step 5: Typecheck + commit.** `pnpm --filter @dudousxd/nestjs-durable-core typecheck` then commit the four source files + specs.

---

### Task 3: Core — regression-lock the stateless-replay execution model

**Files:**
- Test: `packages/core/src/replay-recovery.spec.ts` (create)

**Interfaces:**
- Consumes: `WorkflowEngine`, `InMemoryStateStore`, a fake/event-emitter transport (mirror `durable-step.spec.ts:40-60` harness).

- [ ] **Step 1: Write the test.** A workflow with two `ctx.step` calls (each incrementing a module-level side-effect counter) and one `ctx.remote`. Drive it to completion across turns. Assert: each `ctx.step` closure ran EXACTLY once (counter == 2) despite the body being re-invoked every turn; simulate a "fresh worker" by constructing a SECOND engine over the SAME store mid-run and confirm it replays to the identical frontier (completed steps return cached outputs, closures do NOT re-run — counter unchanged). This locks `engine.ts:2467-2472` behavior.
- [ ] **Step 2: Run it, verify it passes first try** (documenting existing behavior). If it FAILS, stop — the execution-model assumption is wrong and the spec needs revisiting. `pnpm vitest run packages/core/src/replay-recovery.spec.ts`
- [ ] **Step 3: Commit** the spec (no source change).

---

### Task 4: transport-bullmq — dispatch + consume by handler token

**Files:**
- Modify: `packages/transport-bullmq/src/bullmq-transport.ts` (`tasksName` :236; `dispatch` :274; `dispatchWorkflowTask` :284; `handle` :326-340; `runTask` :431; `group` field usages :133/:327/:331/:338; `groupHealth` :394)
- Test: `packages/transport-bullmq/src/bullmq-namespace.spec.ts` + `start-run.spec.ts` (update expectations)

**Interfaces:**
- Consumes: `RemoteTask`/`WorkflowTask` now carrying the handler-derived routing token (from Task 2). `sanitizeQueueToken` (core).
- Produces: dispatch targets `tasksName(prefix, <token from task>)` (unchanged if Task 2 put the token in the read field); `handle(name, fn)` starts ONE `Worker` per registered handler name on `tasksName(prefix, tenantGroup(sanitizeQueueToken(name), this.partition))`, keyed in a `Map<string, Worker>`; drop the `if (!this.group) throw` guard.

- [ ] **Step 1: Write failing tests.** In `bullmq-namespace.spec.ts` (offline bullmq/ioredis mocks), assert: dispatching a `RemoteTask` with name `payments.charge-card` targets queue `durable-tasks-payments.charge-card` (not `durable-tasks-payments`); registering two handlers via `handle('a', …)` + `handle('b', …)` creates TWO Workers on `durable-tasks-a` and `durable-tasks-b`; a name with `:` → sanitized queue (`handle('x:y', …)` → `durable-tasks-x-y`). Rename `group`→`partition` in the transport options where it means isolation.
- [ ] **Step 2: Run, verify fail.** `pnpm vitest run packages/transport-bullmq/src/bullmq-namespace.spec.ts`
- [ ] **Step 3: Implement.** `BullMQTransportOptions.group?` → `partition?` (keep `group?` deprecated alias mapping to `partition`). In `handle(name, fn)`: set the handler in the map; create/cache one `Worker` per name on `this.tasksName(tenantGroup(sanitizeQueueToken(name), this.partition))`; store in `this.taskWorkers: Map<string, Worker>`; start heartbeat per name (or keep a single heartbeat keyed by instance). `dispatch`/`dispatchWorkflowTask`: target `this.tasksName(<routing token carried on the task>)` (already the token if Task 2 populated it; otherwise compute `tenantGroup(sanitizeQueueToken(task.name/task.workflow), task.partition)`). `runTask` unchanged (still `handlers.get(task.name)` after pop — now guaranteed correct since the queue is name-specific). Close all `taskWorkers` on shutdown.
- [ ] **Step 4: Run transport suite.** `pnpm vitest run packages/transport-bullmq` (update `start-run.spec.ts` consumption expectations). Then `pnpm test:db` for `bullmq-transport.db.spec.ts` only if Docker present (`pnpm vitest run --config vitest.db.config.ts packages/transport-bullmq/src/bullmq-transport.db.spec.ts`); if Docker absent, note it as skipped.
- [ ] **Step 5: Typecheck + commit.** `pnpm --filter @dudousxd/nestjs-durable-transport-bullmq typecheck` then commit.

---

### Task 5: worker — enumerate registries + subscribe one consumer per registered name

**Files:**
- Modify: `packages/worker/src/workflow-worker.ts` (`:24`), `packages/worker/src/step-worker.ts` (`:19`)
- Modify: `packages/worker/src/runner-core.ts` (`DurableWorkerRuntime` :112-153)
- Modify: `packages/worker/src/redis-runner.ts` (single Worker :279 → loop; `RunRedisWorkerOptions` :84-123)
- Test: `packages/worker/src/redis-runner.spec.ts`, `workflow-worker.spec.ts`, `step-worker.spec.ts`

**Interfaces:**
- Produces: `WorkflowWorker.names: string[]` (getter → `[...map.keys()]`); `StepWorker.names: string[]`; `DurableWorkerRuntime.registeredNames(): { workflows: string[]; steps: string[] }`. `runRedisWorker` gains `partition?: string` (keep `tenant?` as deprecated alias); it starts one BullMQ `Worker` per name in `runtime.registeredNames()` (workflows ∪ steps), each on `tasksName(prefix, tenantGroup(sanitizeQueueToken(name), partition))`, all sharing the same `processJob`/controller; `RunningWorker.close()` closes all.
- Consumes: `sanitizeQueueToken`, `tenantGroup` (core); `handleTask` (unchanged router).

- [ ] **Step 1: Write failing tests.** `workflow-worker.spec.ts` / `step-worker.spec.ts`: after registering names `a`,`b`, `.names` returns `['a','b']`. `redis-runner.spec.ts` (fake deps capturing every `new Worker` name): a runtime with workflow `pipeline` + step `extraction:page`, run via `runRedisWorker`, creates Workers on `durable-tasks-pipeline` AND `durable-tasks-extraction-page` (sanitized), NOT a single group queue; with `partition: 'davi-local'` → `durable-tasks-pipeline@davi-local` etc. A workflow job still routes to `handleTask` and decisions land on `durable-decisions` (existing assertions preserved, just per-queue).
- [ ] **Step 2: Run, verify fail.** `pnpm vitest run packages/worker/src/redis-runner.spec.ts packages/worker/src/workflow-worker.spec.ts packages/worker/src/step-worker.spec.ts`
- [ ] **Step 3: Implement.** Add the `names` getters + `registeredNames()`. In `redis-runner.ts`, replace the single `new deps.Worker(tasksName(prefix, effectiveGroup), processJob, …)` (`:279`) with a loop over `runtime.registeredNames()` (dedupe workflows ∪ steps into a Set), each creating a Worker on `tasksName(prefix, tenantGroup(sanitizeQueueToken(name), options.partition))`, pushing into a `workers[]`; the `RunningWorker` returned closes all. Keep the producer Queues (`decisions`/`results`/`stepEvents`) as single instances. Preserve single-suffix invariant: `runRedisWorker` applies `tenantGroup(…, options.partition)`; callers pass the RAW name + partition (not pre-suffixed). Keep `RunRedisWorkerOptions.group` accepted (deprecated) — but note `group` is no longer the subscription axis; if provided with no derivable names it is ignored (log a one-time deprecation).
- [ ] **Step 4: Run worker suite.** `pnpm vitest run packages/worker` — `runner-core.spec.ts` routing stays green (`handleTask` unchanged).
- [ ] **Step 5: Typecheck + commit.** `pnpm --filter @dudousxd/durable-worker typecheck` then commit.

---

### Task 6: nestjs — derive worker subscription from discovered handlers; `groups` optional, `tenant`→`partition`

**Files:**
- Modify: `packages/nestjs/src/durable-worker.module.ts` (`DurableWorkerModuleOptions` :42-85; `ThinWorkerBootstrap.onApplicationBootstrap` loop :169-184)
- Modify: `packages/nestjs/src/in-app-worker.ts` if it passes a `group` (`:138`)
- Test: `packages/nestjs/src/durable-worker.module.spec.ts`

**Interfaces:**
- Consumes: `DurableWorkerRuntime.registeredNames()` (Task 5); `runRedisWorker` per-name subscription (Task 5).
- Produces: `DurableWorkerModuleOptions.groups?` now OPTIONAL (kept, deprecated — ignored when handlers are discovered); `partition?: string` added; `tenant?` kept as deprecated alias → `partition`. The bootstrap no longer loops over `options.groups`; it starts ONE `runRedisWorker({ runtime, partition, connection, … })` that internally subscribes per registered name. `concurrencyByGroup` → `concurrencyByHandler?` (keep old key deprecated), keyed by handler name.

- [ ] **Step 1: Write failing tests.** In `durable-worker.module.spec.ts` (fake `runRedisWorker` capturing calls): `DurableWorkerModule.forRoot({ connection })` with `@Workflow('checkout')` + `@Step('charge')` providers and NO `groups` → `runRedisWorker` is called once with the runtime, and driving through it the runtime `handles('checkout')`/`handles('charge')`. With `partition: 'p1'` → the call carries `partition: 'p1'`. Update/replace the old "starts one runner per group" (L177-207) and tenant (L232-268) tests to assert per-handler derivation + `partition` naming instead (a fixture with two `@Workflow`s ⇒ the runner subscribes to both names; assert via the runtime registry or the runner's captured partition).
- [ ] **Step 2: Run, verify fail.** `pnpm vitest run packages/nestjs/src/durable-worker.module.spec.ts`
- [ ] **Step 3: Implement.** Add `partition?: string` to `DurableWorkerModuleOptions`; mark `groups?`/`tenant`/`concurrencyByGroup` deprecated (JSDoc + map `tenant`→partition). In `ThinWorkerBootstrap.onApplicationBootstrap`, drop the `for (const group of this.options.groups)` loop; call `runRedisWorker` once with `{ runtime: this.runtime, partition: this.options.partition ?? this.options.tenant, connection, prefix?, instanceId?, concurrency? }` and push the single handle. The runtime is already populated by `ThinWorkflowRegistrar`/`ThinStepRegistrar` at bootstrap (registrars run before this via provider ordering — verify ordering holds; if not, the bootstrap must run after registration). Keep `tenantGroup` single-application: pass RAW `partition`, let `runRedisWorker` suffix.
- [ ] **Step 4: Run nestjs suite.** `pnpm vitest run packages/nestjs` — `remote-by-convention-module.spec.ts` MUST stay green (operator dispatches `tenantGroup(run.workflow, run.namespace)`; the worker now subscribes to the workflow name suffixed by its partition — assert the convention still lines up; if the spec asserted a group array, update to the derived name).
- [ ] **Step 5: Typecheck + commit.** `pnpm --filter @dudousxd/nestjs-durable typecheck` then commit.

---

### Task 7: nestjs — verify the shipped tenant topology end-to-end under partition

**Files:**
- Test: `packages/nestjs/src/tenant-dashboard.module.spec.ts` (exists) + `durable-start-client.spec.ts` (exists) — adjust to `partition`; add a routing-alignment assertion if missing.

**Interfaces:**
- Consumes: everything from Tasks 2/4/5/6.

- [ ] **Step 1: Write/adjust the test.** Assert an operator (`DurableControlPlaneModule`, `remoteByConvention: true`, `drive`) + a tenant worker (`DurableWorkerModule.forRoot({ partition: 'davi-local' })` serving a `@Workflow('pipeline')`) agree on the queue string: the operator dispatches a `pipeline` turn to `tenantGroup('pipeline', 'davi-local')` and the worker subscribes to the sanitized same. `durable-start-client.spec.ts` passes `partition` (was `tenant`); its tenant-defaulting assertions still hold (`partition` defaults to `'default'` → bare queue).
- [ ] **Step 2: Run, verify** (`pnpm vitest run packages/nestjs/src/tenant-dashboard.module.spec.ts packages/nestjs/src/durable-start-client.spec.ts`).
- [ ] **Step 3: Full JS suite green.** `pnpm test` (whole repo). Fix any straggler group→name/partition expectations. Commit.

---

### Task 8: Python — `group`→`partition`, subscribe per registered handler/workflow name

**Files:**
- Modify: `clients/python/durable_worker/worker.py` (`Worker.__init__` :370-421; add `names`/registry accessors around `:433/:451`)
- Modify: `clients/python/durable_worker/redis_runner.py` (`_names` :208-210; `run_redis_worker` :338-477, esp. :382-388/:468; add `sanitize_queue_token`)
- Test: `clients/python/tests/test_tenant_worker.py`, `test_worker.py`, `test_run_workers.py`

**Interfaces:**
- Produces: `Worker(partition=None, …)` — positional `group` becomes `partition` (keep `group=` keyword as deprecated alias mapping to `partition`, `warnings.warn`). `run_redis_worker` starts one `BullWorker` per name in `self._handlers.keys() ∪ self._workflows.keys()`, each on `f"{prefix}-tasks-{tenant_group(sanitize_queue_token(name), partition)}"`. `sanitize_queue_token(name) = name.replace(':', '-')` — must byte-match JS.
- Consumes: `_tenant_group` (`redis_runner.py:73`), the registries `self._handlers`/`self._workflows`.

- [ ] **Step 1: Write failing tests.** `test_tenant_worker.py` (recording BullMQ `Queue`/`Worker` fakes): a worker with `@worker.workflow('pipeline')` + `@worker.step('extraction:page')` and `partition='davi-local'` creates Workers on `durable-tasks-pipeline@davi-local` AND `durable-tasks-extraction-page@davi-local`; NO single `durable-tasks-processing`. Add a `sanitize_queue_token` unit test matching JS (`'extraction:page'`→`'extraction-page'`). `test_worker.py` pure-dispatch (`process_task`) stays green.
- [ ] **Step 2: Run, verify fail.** `cd clients/python && python -m pytest tests/test_tenant_worker.py -q` (use the repo's Python test invocation — confirm from `pyproject.toml`/CI; likely `pytest` or `uv run pytest`).
- [ ] **Step 3: Implement.** Add `sanitize_queue_token` to `redis_runner.py`. `Worker.__init__`: rename positional `group='default'` → `partition=None`; accept deprecated `group=` kw (if passed, `warnings.warn` + set partition). In `run_redis_worker` (`:382-468`): replace the single-queue build with a loop over the union of `runtime`'s registered handler + workflow names, each `tasks_name = f"{effective_prefix}-tasks-{_tenant_group(sanitize_queue_token(name), partition)}"`, one `BullWorker` per name sharing `process`. Keep `_names`'s format string identical; results queue stays single. Preserve the `_effective_prefix`/`_tenant_group` byte-contract.
- [ ] **Step 4: Run Python suite.** `cd clients/python && python -m pytest -q`. Adjust `test_run_workers.py`/`test_namespace.py` group expectations to per-name.
- [ ] **Step 5: Commit.**

---

### Task 9: Changesets + cross-SDK parity note

**Files:**
- Create: `.changeset/durable-handler-routing.md`
- Create/modify: bump `clients/python/durable_worker/__init__.py` version (`:69`, current `0.19.0b0` → next beta) + any Python version file.

**Interfaces:** none (release metadata).

- [ ] **Step 1:** Write `.changeset/durable-handler-routing.md` with frontmatter `minor` for all four JS packages (`@dudousxd/nestjs-durable-core`, `@dudousxd/nestjs-durable`, `@dudousxd/nestjs-durable-transport-bullmq`, `@dudousxd/durable-worker`) and a body summarizing: `ctx.remote` (alias `ctx.call`), handler-based routing (queue token = sanitized handler name + optional `@partition`), `RemoteStepDef.partition` replacing `group`, `DurableWorkerModule` `groups`→derived, all old names deprecated-aliased; **wire format is a coordinated atomic fleet deploy — bump JS + Python together.**
- [ ] **Step 2:** Bump the Python beta version to match the release train.
- [ ] **Step 3:** `pnpm lint && pnpm typecheck && pnpm build && pnpm test` (full gate) — all green. Commit.

---

## Self-Review

**Spec coverage:** `ctx.remote`+alias → T1; `partition` replaces `group` (core) → T2; stateless-replay lock → T3; per-handler dispatch/consume (transport) → T4; per-handler subscription (worker) → T5; nestjs derivation + `partition` → T6; tenant-topology regression → T7; Python parity → T8; deprecations threaded through T1/T2/T4/T5/T6/T8; migration (aliases + atomic wire) → T9 changeset note. All spec sections mapped.

**Type consistency:** `sanitizeQueueToken`(TS)/`sanitize_queue_token`(Py) defined in T2/T8 and consumed in T4/T5/T8. `tenantGroup(base, partition)` reused everywhere (never forked). `registeredNames()` defined in T5, consumed in T6. Routing token = `tenantGroup(sanitizeQueueToken(name), partition)` — identical expression in T4/T5/T8.

**Sequencing:** T1 additive. T2 changes core routing token but keeps it in the transport-read field so T2 leaves the repo green WITHOUT T4. T4/T5 switch the consumer side. T3/T7 are test-only locks. Each task ends green + committed. Python (T8) is wire-coupled to T4/T5 (same format value) but its own suite is independent.

**Known tradeoff (flagged, not a defect):** per-handler queues = one BullMQ Worker (blocking Redis connection) per distinct registered handler per process. Bounded by distinct-handlers-per-process (flip ~2-4). Documented in spec; not optimized here.

**Open verification for implementers:** (a) exact `RemoteTask`/`WorkflowTask` field the transport reads for the routing token — confirm before deciding whether T2 reuses it or T4 recomputes; (b) provider ordering so registrars populate the runtime before `ThinWorkerBootstrap` runs (T6); (c) Python test invocation command from `clients/python` CI config (T8).
