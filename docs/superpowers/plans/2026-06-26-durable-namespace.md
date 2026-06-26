# Durable namespace (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partition durable runs by `namespace` so a worker only picks up, recovers, resumes-timers-for, and times-out runs in its own namespace — letting non-interchangeable worker pools (e.g. local dev vs the dev cluster) safely share one state store.

**Architecture:** A single engine-global `namespace` (config, default `"default"`) is stamped on each run at creation (`engine.ts:780`, the only `createRun` site, so children inherit it). The four poll paths (`runPending`, `recoverIncomplete`, `resumeDueTimers`, `sweepTimeouts`) pass `this.namespace` to the store's four list methods, which gain an optional namespace filter. `undefined` namespace = no filter = byte-identical to today. Phase 1 implements core + `store-mikro-orm` (the only adapter flip uses) + the `nestjs` wrapper + flip wiring. Drizzle/TypeORM/Prisma parity is an explicit Phase 2 follow-up (kept out so their CI stays green).

**Tech Stack:** TypeScript, pnpm + turbo monorepo, vitest, MikroORM (sqlite for tests), changesets. NestJS for the wrapper. flip-nestjs consumes the published packages.

## Global Constraints

- Repos: lib = `/home/dudousxd/personal/oss/nestjs/nestjs-durable` (git); app = `/home/dudousxd/goflipai/flip-nestjs` (not a git repo in this env — commit there is skipped).
- `WorkflowRun.namespace` is **optional** (`string | undefined`), NOT required — making it required would break every `WorkflowRun` literal in existing specs. The engine stamps it; the store defaults to `'default'` on write.
- Back-compat is non-negotiable: every list method with `namespace === undefined` behaves exactly as before; an engine with no `namespace` configured runs as `'default'`.
- Durable tables are self-managed by the lib (`autoSchema`/`ensureSchema`) — do NOT add a flip MikroORM migration; adding the column+index to the `EntitySchema` is enough.
- No `Co-Authored-By` trailer on commits (user preference). Fixed dependency versions (no `^`/`~`) if any are touched.
- Commit messages: conventional commits, present tense.

---

### Task 1: Core types — `namespace` on `WorkflowRun`, `RunQuery`, and `StateStore`

**Files:**
- Modify: `packages/core/src/interfaces.ts`

**Interfaces:**
- Produces: `WorkflowRun.namespace?: string`; `RunQuery.namespace?: string`; `StateStore.listPendingRuns(limit, namespace?)`, `StateStore.listIncompleteRuns(namespace?)`, `StateStore.listDueTimers(nowMs, namespace?)`.

- [ ] **Step 1: Add `namespace` to `WorkflowRun`**

In `interfaces.ts`, in the `WorkflowRun` interface, add (next to `tags`/`searchAttributes`):

```ts
  /**
   * The worker-pool partition this run belongs to. Stamped at creation from the creating engine's
   * `namespace` (default `'default'`). A worker only picks up / recovers / resumes-timers-for /
   * times-out runs in its own namespace. `undefined` on a run created before this field existed; the
   * store persists it as `'default'`. Read paths (dashboard, `getRun`) are NOT namespace-scoped.
   */
  namespace?: string | undefined;
```

- [ ] **Step 2: Add `namespace` to `RunQuery`**

In the `RunQuery` interface add:

```ts
  /** Restrict to runs in this namespace (exact match), ANDed with the other predicates. */
  namespace?: string | undefined;
```

- [ ] **Step 3: Widen the three `StateStore` list signatures**

Change these three lines in the `StateStore` interface:

```ts
  listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]>;
  listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]>;
  listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]>;
```

- [ ] **Step 4: Typecheck the package**

Run: `cd /home/dudousxd/personal/oss/nestjs/nestjs-durable && pnpm --filter @dudousxd/nestjs-durable-core exec tsc --noEmit`
Expected: PASS (optional params are source-compatible; existing impls still satisfy the interface).

- [ ] **Step 5: Commit**

```bash
cd /home/dudousxd/personal/oss/nestjs/nestjs-durable
git add packages/core/src/interfaces.ts
git commit -m "feat(core): add namespace to WorkflowRun, RunQuery, and StateStore list signatures"
```

---

### Task 2: `InMemoryStateStore` — namespace filtering

**Files:**
- Modify: `packages/core/src/testing/in-memory-state-store.ts`
- Test: `packages/core/src/namespace-store.spec.ts` (create)

**Interfaces:**
- Consumes: the widened `StateStore` signatures and `WorkflowRun.namespace` from Task 1.
- Produces: an `InMemoryStateStore` whose `listPendingRuns`/`listIncompleteRuns`/`listDueTimers`/`listRuns` filter by namespace when one is given.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/namespace-store.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const now = new Date('2026-06-26T00:00:00.000Z');
const base = { workflow: 'w', workflowVersion: '1', input: {}, createdAt: now, updatedAt: now };

describe('InMemoryStateStore namespace filtering', () => {
  it('listPendingRuns filters by namespace, and no-arg returns all (back-compat)', async () => {
    const store = new InMemoryStateStore();
    await store.createRun({ ...base, id: 'a', status: 'pending', namespace: 'alpha' });
    await store.createRun({ ...base, id: 'b', status: 'pending', namespace: 'beta' });
    await store.createRun({ ...base, id: 'c', status: 'pending' }); // legacy, no namespace

    expect((await store.listPendingRuns(10, 'alpha')).map((r) => r.id)).toEqual(['a']);
    expect((await store.listPendingRuns(10)).map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('listIncompleteRuns and listDueTimers filter by namespace', async () => {
    const store = new InMemoryStateStore();
    await store.createRun({ ...base, id: 'r', status: 'running', namespace: 'alpha' });
    await store.createRun({ ...base, id: 's', status: 'running', namespace: 'beta' });
    await store.createRun({
      ...base, id: 't', status: 'suspended', namespace: 'alpha', wakeAt: now.getTime() - 1,
    });
    await store.createRun({
      ...base, id: 'u', status: 'suspended', namespace: 'beta', wakeAt: now.getTime() - 1,
    });

    expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual(['r']);
    expect((await store.listDueTimers(now.getTime(), 'alpha')).map((r) => r.id)).toEqual(['t']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-durable-core exec vitest run src/namespace-store.spec.ts`
Expected: FAIL — `listPendingRuns(10, 'alpha')` returns all three (the param is ignored today).

- [ ] **Step 3: Implement the filters**

In `packages/core/src/testing/in-memory-state-store.ts`, replace the three list methods and add a namespace clause to `listRuns`:

```ts
  async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .filter(
        (r) =>
          (r.status === 'running' || r.status === 'cancelling') &&
          (namespace === undefined || r.namespace === namespace),
      )
      .map((r) => ({ ...r }));
  }
  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.status === 'pending' && (namespace === undefined || r.namespace === namespace))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.status === 'suspended' &&
          r.wakeAt !== undefined &&
          r.wakeAt <= nowMs &&
          (namespace === undefined || r.namespace === namespace),
      )
      .map((r) => ({ ...r }));
  }
```

In `listRuns`, add a namespace predicate alongside the existing `workflow`/`status` filters (find where it filters by `query.workflow`):

```ts
      .filter((r) => query.namespace === undefined || r.namespace === query.namespace)
```

(Insert it into the same filter chain the method already uses for `query.workflow`/`query.status`. If the method builds one `.filter(...)` predicate, AND this clause into it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-durable-core exec vitest run src/namespace-store.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the full core suite (no regressions)**

Run: `pnpm --filter @dudousxd/nestjs-durable-core test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/testing/in-memory-state-store.ts packages/core/src/namespace-store.spec.ts
git commit -m "feat(core): namespace filtering in InMemoryStateStore list methods"
```

---

### Task 3: Core engine — `namespace` config, stamp at creation, filter the four poll paths

**Files:**
- Modify: `packages/core/src/engine.ts`
- Test: `packages/core/src/namespace-engine.spec.ts` (create)

**Interfaces:**
- Consumes: Task 2's filtering `InMemoryStateStore`; `WorkflowRun.namespace`.
- Produces: `WorkflowEngineDeps.namespace?: string`; engine stamps `run.namespace` at `createRun`; `runPending`/`recoverIncomplete`/`resumeDueTimers`/`sweepTimeouts` pass `this.namespace`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/namespace-engine.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('engine namespace partitioning', () => {
  it('stamps created runs with the engine namespace', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} }, // no-op: leave it pending so we can inspect the row
      namespace: 'alpha',
    });
    engine.register('w', '1', async () => 'ok');

    const { runId } = await engine.start('w', {});
    expect((await store.getRun(runId))?.namespace).toBe('alpha');
  });

  it('defaults to "default" when no namespace is configured', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('w', '1', async () => 'ok');

    const { runId } = await engine.start('w', {});
    expect((await store.getRun(runId))?.namespace).toBe('default');
  });

  it('a worker only picks up pending runs in its own namespace', async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    await store.createRun({
      id: 'mine', workflow: 'w', workflowVersion: '1', status: 'pending',
      input: {}, namespace: 'alpha', createdAt: now, updatedAt: now,
    });
    await store.createRun({
      id: 'theirs', workflow: 'w', workflowVersion: '1', status: 'pending',
      input: {}, namespace: 'beta', createdAt: now, updatedAt: now,
    });

    const ran: string[] = [];
    const engine = new WorkflowEngine({ store, namespace: 'alpha' });
    engine.register('w', '1', async (ctx) => {
      ran.push(ctx.runId);
      return 'ok';
    });

    await engine.runPending();
    // give the dispatched run a tick to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(ran).toEqual(['mine']);
    expect((await store.getRun('theirs'))?.status).toBe('pending'); // untouched by the alpha worker
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-durable-core exec vitest run src/namespace-engine.spec.ts`
Expected: FAIL — `namespace` is not a known dep, runs aren't stamped, and `runPending` picks up both.

- [ ] **Step 3: Add the config field and store it**

In `engine.ts`, in the `WorkflowEngineDeps` interface (near `instanceId?`, ~line 200), add:

```ts
  /**
   * Worker-pool partition for this engine. Stamped on every run it creates; the poll paths
   * (`runPending`/`recoverIncomplete`/`resumeDueTimers`/`sweepTimeouts`) only act on runs in this
   * namespace. Default `'default'` — byte-identical to a single-pool deployment. Set distinct values
   * to safely share ONE state store across non-interchangeable pools (e.g. local dev vs a cluster).
   */
  namespace?: string | undefined;
```

In the class fields (near `private readonly instanceId: string;`, ~line 293) add:

```ts
  private readonly namespace: string;
```

In the constructor (near `this.instanceId = deps.instanceId ?? globalThis.crypto.randomUUID();`, ~line 360) add:

```ts
    this.namespace = deps.namespace ?? 'default';
```

- [ ] **Step 4: Stamp the run at creation**

In the `WorkflowRun` literal in `start()` (~line 768), add the `namespace` field:

```ts
    const run: WorkflowRun = {
      id: runId,
      workflow: name,
      workflowVersion: registered.version,
      status: 'pending',
      namespace: this.namespace,
      input,
      tags,
      searchAttributes: opts?.searchAttributes,
      priority: opts?.priority,
      createdAt: now,
      updatedAt: now,
    };
```

(This is the only `store.createRun` call site — children and remote `startChild` flow through `start()`, so they inherit this engine's namespace automatically.)

- [ ] **Step 5: Filter the four poll paths**

In `runPending` (~line 1090):

```ts
    return this.resumeLeased(await this.store.listPendingRuns(100, this.namespace), nowMs);
```

In `recoverIncomplete` (~line 961):

```ts
    for (const run of await this.store.listIncompleteRuns(this.namespace)) {
```

In `resumeDueTimers` (~line 1026):

```ts
    return this.resumeLeased(await this.store.listDueTimers(nowMs, this.namespace), nowMs);
```

In `sweepTimeouts` (~line 945), add `namespace` to both `listRuns` calls:

```ts
      const inflight = [
        ...(await this.store.listRuns({ workflow: reg.name, status: 'running', namespace: this.namespace })),
        ...(await this.store.listRuns({ workflow: reg.name, status: 'suspended', namespace: this.namespace })),
      ];
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-durable-core exec vitest run src/namespace-engine.spec.ts`
Expected: PASS.

- [ ] **Step 7: Run the full core suite**

Run: `pnpm --filter @dudousxd/nestjs-durable-core test`
Expected: PASS (existing engines default to `'default'`; existing tests create runs without a namespace and poll without one, so the contract is unchanged).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/engine.ts packages/core/src/namespace-engine.spec.ts
git commit -m "feat(core): engine namespace config, stamp at creation, and filter the four poll paths"
```

---

### Task 4: `store-mikro-orm` — `namespace` column, index, mapping, and query filters

**Files:**
- Modify: `packages/store-mikro-orm/src/entities.ts`
- Modify: `packages/store-mikro-orm/src/mikro-orm-state-store.ts`
- Test: `packages/store-mikro-orm/src/namespace.spec.ts` (create)

**Interfaces:**
- Consumes: Task 1 types.
- Produces: a `MikroOrmStateStore` whose four list methods filter by namespace, persists `namespace` (default `'default'`), and whose `EntitySchema` carries the column + `(namespace, status)` index (so `ensureSchema`/`autoSchema` create it additively).

- [ ] **Step 1: Write the failing test**

Create `packages/store-mikro-orm/src/namespace.spec.ts`:

```ts
import { type WorkflowRun } from '@dudousxd/nestjs-durable-core';
import { MikroORM } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';

const now = new Date('2026-06-26T00:00:00.000Z');
const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  id: 'x', workflow: 'w', workflowVersion: '1', status: 'pending',
  input: {}, createdAt: now, updatedAt: now, ...over,
});

async function makeStore() {
  const orm = await MikroORM.init({ dbName: ':memory:', entities: [...ENTITIES], allowGlobalContext: true });
  await orm.schema.create();
  return { store: new MikroOrmStateStore(orm), orm };
}

describe('MikroOrmStateStore namespace', () => {
  it('persists namespace and filters list methods; defaults to "default"', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha' }));
    await store.createRun(run({ id: 'b', namespace: 'beta' }));
    await store.createRun(run({ id: 'c' })); // no namespace -> defaults to 'default'

    expect((await store.getRun('a'))?.namespace).toBe('alpha');
    expect((await store.getRun('c'))?.namespace).toBe('default');
    expect((await store.listPendingRuns(10, 'alpha')).map((r) => r.id)).toEqual(['a']);
    expect((await store.listPendingRuns(10)).map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    await orm.close(true);
  });

  it('filters listIncompleteRuns and listDueTimers', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'r', status: 'running', namespace: 'alpha' }));
    await store.createRun(run({ id: 's', status: 'running', namespace: 'beta' }));
    await store.createRun(run({ id: 't', status: 'suspended', namespace: 'alpha', wakeAt: now.getTime() - 1 }));

    expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual(['r']);
    expect((await store.listDueTimers(now.getTime(), 'alpha')).map((r) => r.id)).toEqual(['t']);
    await orm.close(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-durable-store-mikro-orm exec vitest run src/namespace.spec.ts`
Expected: FAIL — `schema.create()` builds no `namespace` column, so `createRun` with `namespace` throws or the field is dropped, and the filters are ignored.

- [ ] **Step 3: Add the column + index to the EntitySchema**

In `packages/store-mikro-orm/src/entities.ts`, add `namespace!: string;` to the `WorkflowRunEntity` class (next to `tags`). Then in the `workflowRuns` `EntitySchema`, add the index and the property:

```ts
    indexes: [
      { name: 'durable_workflow_runs_status_wake_at_idx', properties: ['status', 'wakeAt'] },
      { name: 'durable_workflow_runs_workflow_status_idx', properties: ['workflow', 'status'] },
      { name: 'durable_workflow_runs_namespace_status_idx', properties: ['namespace', 'status'] },
    ],
    properties: {
      id: { type: 'string', primary: true, fieldName: col('id') },
      workflow: { type: 'string', fieldName: col('workflow') },
      // ... existing properties unchanged ...
      namespace: { type: 'string', default: 'default', fieldName: col('namespace') },
      // ... createdAt / updatedAt ...
    },
```

- [ ] **Step 4: Map the field in `toRunEntity` / `fromRunEntity`**

In `packages/store-mikro-orm/src/mikro-orm-state-store.ts`:

In `toRunEntity` (~line 429), add (defaulting so legacy writes get `'default'`):

```ts
    namespace: run.namespace ?? 'default',
```

In `fromRunEntity` (~line 450), add:

```ts
    namespace: e.namespace,
```

- [ ] **Step 5: Filter the four list methods**

In the same file, add the namespace predicate (`...(namespace ? { namespace } : {})` keeps back-compat — `undefined` adds nothing):

```ts
  async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(WorkflowRunEntity, {
      status: { $in: ['running', 'cancelling'] },
      ...(namespace ? { namespace } : {}),
    });
    return rows.map(fromRunEntity);
  }

  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(
      WorkflowRunEntity,
      { status: 'pending', ...(namespace ? { namespace } : {}) },
      { orderBy: { createdAt: 'asc' }, limit },
    );
    return rows.map(fromRunEntity);
  }

  async listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]> {
    const em = this.orm.em.fork();
    const rows = await em.find(WorkflowRunEntity, {
      status: 'suspended',
      wakeAt: { $ne: null, $lte: new Date(nowMs) },
      ...(namespace ? { namespace } : {}),
    });
    return rows.map(fromRunEntity);
  }
```

In `listRuns`, after `if (query.workflow) where.workflow = query.workflow;`, add:

```ts
    if (query.namespace !== undefined) where.namespace = query.namespace;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-durable-store-mikro-orm exec vitest run src/namespace.spec.ts`
Expected: PASS.

- [ ] **Step 7: Run the full store suite (contract + sqlite specs)**

Run: `pnpm --filter @dudousxd/nestjs-durable-store-mikro-orm test`
Expected: PASS — the shared contract creates runs without a namespace and lists without one, so the new optional column/filter doesn't change it.

- [ ] **Step 8: Commit**

```bash
git add packages/store-mikro-orm/src/entities.ts packages/store-mikro-orm/src/mikro-orm-state-store.ts packages/store-mikro-orm/src/namespace.spec.ts
git commit -m "feat(store-mikro-orm): namespace column, index, mapping, and list filters"
```

---

### Task 5: `nestjs` wrapper — accept and forward `namespace`

**Files:**
- Modify: `packages/nestjs/src/durable.module.ts`

**Interfaces:**
- Consumes: `WorkflowEngineDeps.namespace` from Task 3.
- Produces: `DurableModuleOptions.namespace?: string`, forwarded to `new WorkflowEngine`.

- [ ] **Step 1: Add the option to `DurableModuleOptions`**

In `durable.module.ts`, in `DurableModuleOptions` (~line 132, near `leaseMs?`), add:

```ts
  /**
   * Worker-pool partition for this instance (forwarded to the engine). Default `'default'`. Set a
   * distinct value to share ONE state store across non-interchangeable pools — e.g. a developer's
   * local instance vs the deployed cluster. See {@link WorkflowEngineDeps.namespace}.
   */
  namespace?: string;
```

- [ ] **Step 2: Forward it to the engine**

In the `new WorkflowEngine({ ... })` block (~line 332), add a line next to `instanceId: opts.instanceId,`:

```ts
              namespace: opts.namespace,
```

- [ ] **Step 3: Typecheck the package**

Run: `pnpm --filter @dudousxd/nestjs-durable exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the package suite**

Run: `pnpm --filter @dudousxd/nestjs-durable test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nestjs/src/durable.module.ts
git commit -m "feat(nestjs): accept and forward namespace option to the engine"
```

---

### Task 6: Release the lib (changeset) and full-local validation

**Files:**
- Create: `.changeset/durable-namespace.md`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: a published set of versions for flip to consume; a green full-local proof that partitioning works before any dev deploy.

- [ ] **Step 1: Add a changeset**

Create `.changeset/durable-namespace.md`:

```md
---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable': minor
---

Add `namespace` run partitioning. An engine configured with a `namespace` stamps it on every run it
creates and only picks up / recovers / resumes-timers-for / times-out runs in that namespace. The
StateStore list methods (`listPendingRuns`, `listIncompleteRuns`, `listDueTimers`) and `RunQuery`
gain an optional namespace filter. Default `'default'` — byte-identical to a single-pool deployment.
Implemented for the MikroORM store; Drizzle/TypeORM/Prisma parity is a follow-up (they ignore the
filter until then). Read paths (dashboard, `getRun`) are intentionally not namespace-scoped.
```

- [ ] **Step 2: Build all touched packages**

Run: `cd /home/dudousxd/personal/oss/nestjs/nestjs-durable && pnpm --filter @dudousxd/nestjs-durable-core --filter @dudousxd/nestjs-durable-store-mikro-orm --filter @dudousxd/nestjs-durable build`
Expected: PASS.

- [ ] **Step 3: Lint/format gate (repo convention)**

Run: `pnpm biome check packages/core/src/interfaces.ts packages/core/src/engine.ts packages/core/src/testing/in-memory-state-store.ts packages/store-mikro-orm/src/entities.ts packages/store-mikro-orm/src/mikro-orm-state-store.ts packages/nestjs/src/durable.module.ts`
Expected: PASS (run `pnpm biome format --write <files>` first if it flags formatting).

- [ ] **Step 4: Commit and push for CI to publish**

```bash
git add .changeset/durable-namespace.md
git commit -m "chore: changeset for durable namespace partitioning"
git push
```

Then let the changesets GitHub action open/merge the version PR and publish (do NOT publish by hand). Note the published versions of the three packages for Task 7.

- [ ] **Step 5: Full-local proof (no dev dependency)**

Before touching flip's dev wiring, prove isolation end-to-end against a local DB. In a scratch script or a `*.db.spec.ts` against a local MySQL, start two engines on ONE store with namespaces `alpha` and `beta`, enqueue one run each, run both pollers, and assert each engine ran only its own run. (The Task 3 in-memory test already proves the logic; this confirms it on MySQL with the new column/index.)

Run: `pnpm --filter @dudousxd/nestjs-durable-store-mikro-orm test:db` (if a local MySQL is configured for the `*.db.spec.ts` suite)
Expected: PASS.

---

### Task 7: flip-nestjs wiring + local env

**Files:**
- Modify: `/home/dudousxd/goflipai/flip-nestjs/package.json` (durable dep versions)
- Modify: `/home/dudousxd/goflipai/flip-nestjs/src/durable/durable-orchestrator.module.ts`
- Modify: `/home/dudousxd/goflipai/flip-nestjs/.env` (local) and `.env.example`

**Interfaces:**
- Consumes: the published `namespace` option (Task 5/6).
- Produces: flip pods read `DURABLE_NAMESPACE` (default `'default'`); local dev runs as `davi-local`.

- [ ] **Step 1: Bump the durable dependencies**

In `flip-nestjs/package.json`, set the three packages to the versions published in Task 6 (exact pins, no `^`/`~`):
`@dudousxd/nestjs-durable`, `@dudousxd/nestjs-durable-core`, `@dudousxd/nestjs-durable-store-mikro-orm`.

Run: `cd /home/dudousxd/goflipai/flip-nestjs && pnpm install`
Expected: lockfile updates; install succeeds.

- [ ] **Step 2: Pass `namespace` in the durable module**

In `src/durable/durable-orchestrator.module.ts`, inside the `DurableModule.forRootAsync` `useFactory` return object (next to `instanceId: process.env.HOSTNAME,`), add:

```ts
          namespace: process.env.DURABLE_NAMESPACE ?? "default",
```

- [ ] **Step 3: Document the env var**

In `.env.example`, add:

```
# Durable worker-pool partition. Leave unset (="default") in dev/prod. Set a unique value locally
# (e.g. DURABLE_NAMESPACE=davi-local) so the dev cluster doesn't execute your locally-triggered runs.
DURABLE_NAMESPACE=
```

In your local `.env`, set:

```
DURABLE_NAMESPACE=davi-local
```

- [ ] **Step 4: Build + typecheck flip**

Run: `cd /home/dudousxd/goflipai/flip-nestjs && pnpm run build`
Expected: PASS.

- [ ] **Step 5: Deploy to dev FIRST (the rollout gate)**

Push flip to `master` so `deploy-dev.yml` ships the new lib to the dev cluster. The dev cluster must run the filtering lib (as `namespace='default'`) BEFORE local isolation works — otherwise its unfiltered `listPendingRuns()` still steals `davi-local` runs. The change is additive/back-compat: `autoSchema` adds the `namespace` column to dev RDS on boot; existing rows read as `'default'`.

- [ ] **Step 6: Verify local isolation**

With dev on the new lib: boot flip-nestjs local (`APP_TYPE=ALL`, `DURABLE_NAMESPACE=davi-local`, `DATABASE_HOST`=dev RDS, `S3_URL`=local MinIO, `REDIS_HOST`=localhost) and flip-python-db local (Redis=localhost). Put the file in local MinIO at the key you'll pass. Trigger the ingestion-only pipeline from the local UI.

Expected: the run executes locally (reads local MinIO, no `NoSuchKey`); in dev RDS the run's `namespace` is `davi-local`; no `flip-worker-...-dev-*` pod appears in its `lockedBy`/step history.
```
