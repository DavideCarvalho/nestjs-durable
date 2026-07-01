# Uniform Durable Start (tenant `engine.start` → control plane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `engine.start(WorkflowClass, input, runId, opts)` uniform across topologies — a tenant app (no store) calls the exact same API, and it transparently notifies the control plane via a start-run message instead of touching a DB.

**Architecture:** A store-less `DurableStartClient` is provided under the `WorkflowEngine` DI token by `DurableWorkerModule`. Its `start()` resolves the workflow name from the class, mints/keeps a runId, and dispatches a `StartRunMessage` on the SHARED `durable-start-run` queue (Option B: tenant rides as message DATA, never as wire segmentation). The operator (control plane, `namespace: undefined`) consumes that queue, stamps the run's namespace from `message.tenant`, and dispatches the run's task to `tenantGroup(workflow, namespace)` — the `<group>@<tenant>` group the tenant's worker serves. `searchAttributes` is threaded end-to-end so a tenant start carries the same queryable data a local start does. `cancel`/`deleteRun` on the facade throw a clear tenant error (no wire message exists for them, out of scope).

**Tech Stack:** TypeScript (strict), pnpm + turbo monorepo, vitest, changesets, BullMQ/Redis transport, NestJS 11.

## Global Constraints

- **Uniform API:** a tenant calls `engine.start(...)` — NEVER expose `start_run` / `startRun` as an app-facing call. The dispatch is transparent, under the `WorkflowEngine` token.
- **Option B wire routing:** tenant is a DATA field on the message + a group suffix; it MUST NOT segment the start-run queue. The `DurableStartClient` leaves `startRun`'s `namespace` arg **undefined** so the queue stays the bare `durable-start-run` the operator consumes.
- **Byte-identical rule:** `tenant` of `undefined`, `''`, or `'default'` maps to the bare group (production single-pool unchanged); any other tenant → `<group>@<tenant>`. Owned by `tenantGroup()` (already shipped).
- **No `as` / `any` / `unknown` / `never`** in new code (except pre-existing patterns in files being edited — do not add new ones). `RedisConnection` is already `unknown`, so `options.connection` passes without a cast.
- **Function declarations, not arrows** for module-level/class-method style where the codebase already does so; match surrounding style.
- **Fixed exact versions** (no `^`/`~`) anywhere a version is written.
- **No Co-Authored-By** trailer on commits.
- **Libs commit locally to `main`, but DO NOT push or publish** without explicit confirmation. Publishing a new beta is a separate, gated step (see Appendix B).
- **TDD:** every task starts with a failing test.
- **`searchAttributes` type:** `Record<string, string | number | boolean>` = `SearchAttributes`, exported from `@dudousxd/nestjs-durable-core`.

---

## File Structure

- `packages/core/src/interfaces.ts` — add `searchAttributes?` to `StartRunMessage`.
- `packages/core/src/engine.ts` — thread `message.searchAttributes` in the operator's `onStartRun` handler.
- `packages/worker/src/redis-runner.ts` — add `searchAttributes?` to `StartRunOptions` + the `msg` build in `startRun`.
- `packages/nestjs/src/durable-start-client.ts` — **new**: the store-less `DurableStartClient` facade.
- `packages/nestjs/src/durable-worker.module.ts` — provide `DurableStartClient` under the `WorkflowEngine` token + provide/export `WorkflowService`.
- `packages/nestjs/src/index.ts` — export `DurableStartClient` (if the barrel exports classes; match its pattern).
- `.changeset/uniform-durable-start.md` — changeset (minor bump for core, worker, nestjs).

---

## Task 1: `searchAttributes` on `StartRunMessage` + operator handler

**Files:**
- Modify: `packages/core/src/interfaces.ts:462-471` (the `StartRunMessage` interface)
- Modify: `packages/core/src/engine.ts:486-496` (the `onStartRun` handler)
- Test: `packages/core/src/engine.spec.ts` (or the existing start-run test file — locate the test that already exercises `onStartRun`/`StartRunMessage` and add there)

**Interfaces:**
- Consumes: `SearchAttributes` (already exported from `interfaces.ts:388`), `StartOptions.searchAttributes` (already on the interface at `engine.ts:76`).
- Produces: `StartRunMessage.searchAttributes?: SearchAttributes | undefined`; the operator's `onStartRun` now passes it into `start()`.

- [ ] **Step 1: Write the failing test**

Find the existing test that drives `onStartRun` (search `onStartRun` / `StartRunMessage` in `packages/core/src/*.spec.ts`). Add a case: publish a start-run message carrying `searchAttributes`, then assert the created run's `searchAttributes` equals it. Sketch (adapt to the file's existing harness/fakes):

```ts
it('stamps searchAttributes from a start-run message onto the created run', async () => {
  // arrange: an operator engine (namespace: undefined) with a fake pool exposing onStartRun
  await pool.emitStartRun({
    tenant: 'acme',
    workflow: 'demo',
    input: { n: 1 },
    runId: 'run-sa-1',
    searchAttributes: { tier: 'pro', amount: 200 },
  });
  const run = await store.getRun('run-sa-1');
  expect(run?.searchAttributes).toEqual({ tier: 'pro', amount: 200 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-durable-core test -- engine`
Expected: FAIL — `searchAttributes` is `undefined` on the run (handler doesn't forward it), or a TS error that `searchAttributes` is not on `StartRunMessage`.

- [ ] **Step 3: Add the field to `StartRunMessage`**

In `interfaces.ts`, inside `StartRunMessage` (after the `tags?` field at line 470):

```ts
  /** Typed, queryable run data to stamp on the run (same as {@link StartOptions.searchAttributes}). */
  searchAttributes?: SearchAttributes | undefined;
```

(`SearchAttributes` is already declared in this file at line 388 — no import needed.)

- [ ] **Step 4: Thread it in the operator handler**

In `engine.ts`, the `onStartRun` handler (lines 486-496), add `searchAttributes` to the opts object passed to `start`:

```ts
    this.pool.onStartRun(async (message) => {
      await this.start(
        message.workflow,
        message.input,
        message.runId ?? globalThis.crypto.randomUUID(),
        {
          namespace: message.tenant,
          tags: message.tags,
          searchAttributes: message.searchAttributes,
        },
      );
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-durable-core test -- engine`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/interfaces.ts packages/core/src/engine.ts packages/core/src/*.spec.ts
git commit -m "feat(core): carry searchAttributes on StartRunMessage into the started run"
```

---

## Task 2: `searchAttributes` on `startRun` dispatch

**Files:**
- Modify: `packages/worker/src/redis-runner.ts:352-380` (`StartRunOptions`) and `:406-412` (the `msg` build in `startRun`)
- Test: `packages/worker/src/redis-runner.spec.ts`

**Interfaces:**
- Consumes: `StartRunMessage.searchAttributes` (Task 1), `SearchAttributes` from `@dudousxd/nestjs-durable-core`.
- Produces: `StartRunOptions.searchAttributes?: SearchAttributes | undefined`; `startRun` forwards it onto the enqueued `StartRunMessage`.

- [ ] **Step 1: Write the failing test**

In `redis-runner.spec.ts`, find the existing `startRun` test that uses the `deps` fake Queue and captures the added job. Add a case asserting `searchAttributes` rides the message:

```ts
it('forwards searchAttributes onto the start-run message', async () => {
  const added: unknown[] = [];
  const deps = { Queue: makeFakeQueue(added) }; // reuse the file's existing fake-Queue helper
  await startRun('redis://x', {
    tenant: 'acme',
    workflow: 'demo',
    input: { n: 1 },
    runId: 'r1',
    searchAttributes: { tier: 'pro' },
    deps,
  });
  expect(added[0]).toMatchObject({ searchAttributes: { tier: 'pro' } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/durable-worker test -- redis-runner`
Expected: FAIL — TS error that `searchAttributes` is not on `StartRunOptions`, or the added message lacks it.

- [ ] **Step 3: Add the field to `StartRunOptions`**

In `redis-runner.ts`, ensure `SearchAttributes` is imported from `@dudousxd/nestjs-durable-core` (the file already imports `StartRunMessage` from core — add `SearchAttributes` to that same import). Then in `StartRunOptions` (after `tags?` at line 370):

```ts
  /** Typed, queryable run data merged into the run at creation. */
  searchAttributes?: SearchAttributes | undefined;
```

- [ ] **Step 4: Forward it in the `msg` build**

In `startRun` (after the `tags` line at 412):

```ts
  if (opts.searchAttributes !== undefined) msg.searchAttributes = opts.searchAttributes;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/durable-worker test -- redis-runner`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/redis-runner.ts packages/worker/src/redis-runner.spec.ts
git commit -m "feat(worker): forward searchAttributes through startRun onto the start-run message"
```

---

## Task 3: `DurableStartClient` — store-less `engine.start` facade

**Files:**
- Create: `packages/nestjs/src/durable-start-client.ts`
- Test: `packages/nestjs/src/durable-start-client.spec.ts`

**Interfaces:**
- Consumes: `startRun`, `type StartRunDeps` from `@dudousxd/durable-worker`; `type DurableWorkerModuleOptions` from `./durable-worker.module`; `workflowName`, `type WorkflowClass`, `type WorkflowInputOf`, `type StartOptions`, `type RunResult` from `@dudousxd/nestjs-durable-core`.
- Produces: `class DurableStartClient` with `start<C extends WorkflowClass>(workflow, input, runId?, opts?): Promise<RunResult>` (+ a string overload), `cancel(runId): Promise<void>` (throws), `deleteRun(runId): Promise<void>` (throws). These mirror the subset of `WorkflowEngine` a tenant app calls.

**Design notes (read before implementing):**
- `start` reuses the tested `startRun` free function. It passes `namespace: undefined` so the start-run queue stays the SHARED `durable-start-run` the operator consumes (Option B — tenant is DATA, not wire segmentation).
- `runId` is minted here (`runId ?? globalThis.crypto.randomUUID()`) and passed to `startRun` VERBATIM, so the returned `runId` is authoritative AND redelivery is idempotent. The returned status is always `'pending'` (the run is enqueued, a worker runs the body).
- `tenant` on the message = `options.tenant ?? 'default'`. A `DurableStartClient` only exists in a tenant deployment; `'default'` is the byte-identical fallback if unset.
- `cancel`/`deleteRun` require the store/driver — a tenant has neither. Throw a clear error naming the constraint. No wire message exists for them (out of scope).
- Accept an optional `StartRunDeps` (fake Queue ctor) so the spec drives `start` without real Redis — pass it through to `startRun`'s `deps`.

- [ ] **Step 1: Write the failing test**

`packages/nestjs/src/durable-start-client.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Workflow } from '@dudousxd/nestjs-durable-core';
import { DurableStartClient } from './durable-start-client';

@Workflow({ name: 'demo', version: '1' })
class DemoWorkflow {
  run() {
    return null;
  }
}

function makeFakeQueue(sink: { name: string; data: unknown }[]) {
  return class {
    constructor(_name: string, _opts: Record<string, unknown>) {}
    async add(name: string, data: unknown) {
      sink.push({ name, data });
      return undefined;
    }
    async close() {}
  };
}

describe('DurableStartClient', () => {
  it('dispatches a start-run message stamped with tenant, workflow name, input, runId, and searchAttributes', async () => {
    const sink: { name: string; data: unknown }[] = [];
    const client = new DurableStartClient(
      { connection: 'redis://x', groups: ['pipeline'], tenant: 'davi-local' },
      { Queue: makeFakeQueue(sink) },
    );

    const result = await client.start(DemoWorkflow, { n: 1 }, 'run-1', {
      tags: ['t'],
      searchAttributes: { tier: 'pro' },
    });

    expect(result).toEqual({ runId: 'run-1', status: 'pending' });
    expect(sink).toHaveLength(1);
    expect(sink[0].name).toBe('startRun');
    expect(sink[0].data).toMatchObject({
      tenant: 'davi-local',
      workflow: 'demo',
      input: { n: 1 },
      runId: 'run-1',
      tags: ['t'],
      searchAttributes: { tier: 'pro' },
    });
  });

  it('mints a runId when the caller omits one and returns it', async () => {
    const sink: { name: string; data: unknown }[] = [];
    const client = new DurableStartClient(
      { connection: 'redis://x', groups: ['pipeline'], tenant: 'davi-local' },
      { Queue: makeFakeQueue(sink) },
    );
    const result = await client.start(DemoWorkflow, { n: 2 });
    expect(result.status).toBe('pending');
    expect(result.runId).toMatch(/[0-9a-f-]{36}/);
    expect((sink[0].data as { runId: string }).runId).toBe(result.runId);
  });

  it('falls back to the default tenant when none is configured', async () => {
    const sink: { name: string; data: unknown }[] = [];
    const client = new DurableStartClient(
      { connection: 'redis://x', groups: ['pipeline'] },
      { Queue: makeFakeQueue(sink) },
    );
    await client.start(DemoWorkflow, { n: 3 }, 'r3');
    expect((sink[0].data as { tenant: string }).tenant).toBe('default');
  });

  it('throws on cancel and deleteRun (no store on a tenant)', async () => {
    const client = new DurableStartClient(
      { connection: 'redis://x', groups: ['pipeline'], tenant: 'davi-local' },
      { Queue: makeFakeQueue([]) },
    );
    await expect(client.cancel('r1')).rejects.toThrow(/tenant/i);
    await expect(client.deleteRun('r1')).rejects.toThrow(/tenant/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-durable test -- durable-start-client`
Expected: FAIL — module `./durable-start-client` not found.

- [ ] **Step 3: Implement `DurableStartClient`**

`packages/nestjs/src/durable-start-client.ts`:

```ts
import { type StartRunDeps, startRun } from '@dudousxd/durable-worker';
import {
  type RunResult,
  type StartOptions,
  type WorkflowClass,
  type WorkflowInputOf,
  workflowName,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import type { DurableWorkerModuleOptions } from './durable-worker.module';

/**
 * The **store-less `engine.start` facade** for a tenant worker. Provided under the `WorkflowEngine`
 * DI token by {@link DurableWorkerModule}, so tenant code calls `engine.start(...)` UNCHANGED — it
 * has no idea it is a tenant. Instead of touching a DB, `start` publishes a `StartRunMessage` on the
 * SHARED `durable-start-run` queue (Option B: tenant rides as message DATA, never as wire
 * segmentation). The operator (control plane, `namespace: undefined`) consumes it, stamps the run's
 * namespace from `tenant`, and routes the run's task to `<workflow>@<tenant>` — the group THIS
 * tenant's worker serves.
 *
 * `cancel`/`deleteRun` need the store/driver a tenant does not have; they throw. No wire message
 * exists for them (the operator owns cancellation/retention).
 */
@Injectable()
export class DurableStartClient {
  private readonly tenant: string;

  constructor(
    private readonly options: DurableWorkerModuleOptions,
    private readonly deps?: StartRunDeps,
  ) {
    this.tenant = options.tenant ?? 'default';
  }

  start<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId?: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  start(workflow: string, input: unknown, runId?: string, opts?: StartOptions): Promise<RunResult>;
  async start(
    workflow: string,
    input: unknown,
    runId: string = globalThis.crypto.randomUUID(),
    opts?: StartOptions,
  ): Promise<RunResult> {
    const name = workflowName(workflow);
    await startRun(this.options.connection, {
      tenant: this.tenant,
      workflow: name,
      input,
      runId,
      // Option B: DO NOT pass `namespace` — the start-run queue stays the shared
      // `durable-start-run` the operator consumes; tenant rides only as message data.
      ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
      ...(opts?.tags !== undefined ? { tags: opts.tags } : {}),
      ...(opts?.searchAttributes !== undefined ? { searchAttributes: opts.searchAttributes } : {}),
      ...(this.deps !== undefined ? { deps: this.deps } : {}),
    });
    return { runId, status: 'pending' };
  }

  cancel(_runId: string): Promise<void> {
    return Promise.reject(
      new Error(
        'cancel() is not available on a tenant worker (no store). Cancel from the control plane.',
      ),
    );
  }

  deleteRun(_runId: string): Promise<void> {
    return Promise.reject(
      new Error(
        'deleteRun() is not available on a tenant worker (no store). Delete from the control plane.',
      ),
    );
  }
}
```

Note: `workflowName(workflow)` accepts a class (reads the `@Workflow` name symbol) or a string. If `workflowName` is not exported from the core barrel, add it: `export { workflowName } from './workflow-ref';` in `packages/core/src/index.ts`, and commit that with this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-durable test -- durable-start-client`
Expected: PASS (all four cases).

- [ ] **Step 5: Typecheck the package**

Run: `pnpm --filter @dudousxd/nestjs-durable typecheck` (or the repo's `tsc --noEmit` script for that package)
Expected: no errors (confirms no `as`/`any` slipped in and the `RunResult`/`StartOptions` shapes match).

- [ ] **Step 6: Commit**

```bash
git add packages/nestjs/src/durable-start-client.ts packages/nestjs/src/durable-start-client.spec.ts packages/core/src/index.ts
git commit -m "feat(nestjs): add store-less DurableStartClient (tenant engine.start -> start-run)"
```

---

## Task 4: Wire `DurableStartClient` into `DurableWorkerModule`

**Files:**
- Modify: `packages/nestjs/src/durable-worker.module.ts:189-204` (the `build` providers/exports)
- Modify: `packages/nestjs/src/index.ts` (export `DurableStartClient`)
- Test: `packages/nestjs/src/durable-worker.module.spec.ts` (or the existing module spec)

**Interfaces:**
- Consumes: `DurableStartClient` (Task 3), `WorkflowEngine` + `WorkflowService` from core/nestjs.
- Produces: a `DurableWorkerModule` that provides & exports `WorkflowEngine` (backed by `DurableStartClient`) and `WorkflowService`, so tenant code injecting either resolves the facade.

**Design note:** Nest's `FactoryProvider` does NOT bind the token's declared type to the factory's return type — `{ provide: WorkflowEngine, useFactory: () => new DurableStartClient(...) }` compiles with NO cast, and injection sites (`constructor(private engine: WorkflowEngine)`) trust the token's type. This is the whole reason a lightweight facade can sit under the `WorkflowEngine` token and keep flip's code byte-identical.

- [ ] **Step 1: Write the failing test**

In the module spec, build a `DurableWorkerModule` test module and assert the `WorkflowEngine` token resolves to a `DurableStartClient` and that `WorkflowService` resolves and delegates. Use `overrideProvider(RUN_REDIS_WORKER)` with a no-op (as the existing module spec already does) so no real Redis worker starts:

```ts
it('provides a store-less start facade under the WorkflowEngine token', async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [DurableWorkerModule.forRoot({ connection: 'redis://x', groups: ['pipeline'], tenant: 'davi-local' })],
  })
    .overrideProvider(RUN_REDIS_WORKER)
    .useValue(async () => ({ close: async () => {} }))
    .compile();

  const engine = moduleRef.get(WorkflowEngine);
  expect(engine).toBeInstanceOf(DurableStartClient);

  const service = moduleRef.get(WorkflowService);
  expect(service).toBeInstanceOf(WorkflowService);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-durable test -- durable-worker.module`
Expected: FAIL — `Nest can't resolve WorkflowEngine` (not provided by the worker module).

- [ ] **Step 3: Provide the facade + WorkflowService**

In `durable-worker.module.ts`, add imports at the top:

```ts
import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { DurableStartClient } from './durable-start-client';
import { WorkflowService } from './workflow.service';
```

In `build`'s `providers` array (after `ThinWorkerBootstrap`), add:

```ts
        {
          provide: WorkflowEngine,
          useFactory: (options: DurableWorkerModuleOptions) => new DurableStartClient(options),
          inject: [DURABLE_WORKER_OPTIONS],
        },
        WorkflowService,
```

And extend `exports`:

```ts
      exports: [DurableWorkerRuntime, WorkflowEngine, WorkflowService],
```

- [ ] **Step 4: Export `DurableStartClient` from the barrel**

In `packages/nestjs/src/index.ts`, add (matching the barrel's existing export style):

```ts
export { DurableStartClient } from './durable-start-client';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-durable test -- durable-worker.module`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/nestjs/src/durable-worker.module.ts packages/nestjs/src/index.ts
git commit -m "feat(nestjs): DurableWorkerModule provides engine.start facade under WorkflowEngine token"
```

---

## Task 5: Changeset + monorepo gate

**Files:**
- Create: `.changeset/uniform-durable-start.md`

- [ ] **Step 1: Write the changeset**

`.changeset/uniform-durable-start.md`:

```md
---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable": minor
---

Uniform durable start for tenant apps. `engine.start(...)` is now identical across topologies: a
tenant worker (no store) resolves the same `WorkflowEngine` token to a store-less `DurableStartClient`
that transparently publishes a start-run message to the control plane instead of touching a DB.
`searchAttributes` now ride the start-run path (`StartRunMessage` → `startRun` → the created run), so a
tenant start carries the same queryable data a local start does. `cancel`/`deleteRun` on a tenant
worker throw (the operator owns cancellation/retention). No app-facing `start_run` call is introduced.
```

- [ ] **Step 2: Full build**

Run: `pnpm build`
Expected: all packages build (confirms `DurableStartClient`'s imports resolve across package boundaries).

- [ ] **Step 3: Full test + typecheck**

Run: `pnpm test` then `pnpm -r typecheck` (or the repo's `check` script)
Expected: green. If the repo has a biome/format gate, run it too (`pnpm biome check` or the repo script) and fix any formatting.

- [ ] **Step 4: Commit**

```bash
git add .changeset/uniform-durable-start.md
git commit -m "chore: changeset for uniform durable start"
```

---

## Appendix A — flip adoption (gated on a new beta; execute AFTER Appendix B)

This is the flip side of the increment. It is **not** part of the lib SDD run — it lands in `flip-nestjs` and `flip-python-db` once a beta carrying Tasks 1–5 is published and pinned. flip's tenant deployment is a developer's local stack; the control plane is dev.

**Key property (already true):** flip's `DurableOrchestratorService.startPipeline` already calls `this.engine.start(PipelineWorkflow, {...}, runId, { tags, searchAttributes })`. Under the tenant module it resolves the `DurableStartClient` — **the orchestrator code does not change.**

### A1. flip-nestjs — split control-plane vs tenant

- The dev-cluster deployment keeps `DurableModule.forRootAsync(...)` with `namespace: undefined` (the operator — already applied, uncommitted in `durable-orchestrator.module.ts`).
- A **tenant** deployment (local flip) imports `DurableWorkerModule.forRootAsync({ connection, groups: ['pipeline', /* + the pipeline's @Step groups */], tenant: process.env.DURABLE_TENANT })` and **no store**. The `pipeline` @Workflow + its `@Step` handlers (which carry the app deps `EntityManager`/`FileUploadService`/`SlackNotifierService`/`BentoCache`) run on this tenant worker, so the DB-bound body executes locally where those deps live; the `processing` child stays remote (Python).
- Select the module by role (`DURABLE_TENANT` set → tenant/worker module; unset → control-plane module). Keep the pins on the beta from Appendix B until the final release.

### A2. flip-python-db — already tenant-shaped

`durable_processing_workflow_worker.py` already uses `Worker(group="processing", tenant=os.getenv("DURABLE_TENANT"))` and `durable-worker[redis]==0.19.0b0`. Bump the pin to the new beta from Appendix B and confirm imports clean (`venv/bin/python -c "import app.durable_processing_workflow_worker"`).

### A3. Live test (needs Davi's explicit OK — involves a dev deploy)

dev control plane (operator) + local flip tenant worker (`pipeline@davi-local`) + local Python tenant worker (`processing@davi-local`): trigger a pipeline from local flip via `engine.start(PipelineWorkflow, ...)`, confirm the operator creates the run, routes `pipeline` to the flip tenant worker and `processing` to the Python tenant worker, and that retry/cancel/orphan-checks are driven by the dev operator.

## Appendix B — publish a new beta (gated)

After Tasks 1–5 land on `main` (committed, NOT pushed without confirmation), publish a snapshot beta via the `release-snapshot.yml` workflow (`changeset version --snapshot beta` + `changeset publish --tag beta --no-git-tag`) — do NOT enter changesets pre-mode (it cascades bogus MAJORs). This yields `0.0.0-beta-<ts>` under the `beta` dist-tag for `@dudousxd/nestjs-durable-core`, `@dudousxd/durable-worker`, `@dudousxd/nestjs-durable` (+ PyPI `durable-worker` beta for the Python side). Confirm with Davi before dispatching. Then pin flip's 5 durable deps + `requirements.txt` to the new beta.
