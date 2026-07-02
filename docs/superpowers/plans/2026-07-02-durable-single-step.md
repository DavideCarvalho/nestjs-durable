# Durable single-step (`@Step` + `ctx.step`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the durable step surface to ONE always-durable, engine-scheduled `ctx.step` — called by typed method reference (`@Step`-decorated) or by string name (cross-runtime) — removing `ctx.remote`, the inline `ctx.step(closure)`, `remoteStep()`, and `RemoteStepDef`, and adding `ctx.now()`/`ctx.uuid()` deterministic-capture helpers.

**Architecture:** Pure authoring-surface rename over the UNCHANGED cross-SDK wire (`kind:'call'` decision + `recordStep` history stay byte-identical). `ctx.step` (new) is today's `ctx.remote` (dispatch by handler name + `Suspend`). The `@Step` decorator stamps a `Symbol.for`-keyed routing name on the method, which core's `ctx.step` reads to route a method-reference call. Trivial captures move from inline steps to `ctx.now()`/`ctx.uuid()`, which reuse the existing `recordStep` machinery.

**Tech Stack:** pnpm+turbo+tsup monorepo, vitest, biome 1.9.4, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess`. Python `durable-worker` (mirrors). Downstream: flip-nestjs.

## Global Constraints

- **Wire is frozen.** No change to the decision/history protocol: `ctx.step` emits the SAME `{ kind:'call', seq, name, group, input }` + `throw new Suspend()` as today's `ctx.remote`; `ctx.now`/`ctx.uuid`/`transaction` produce `recordStep`. Any task that touches the wire is out of scope — flag it, don't do it.
- **No deprecation aliases.** Remove `ctx.remote`, `remoteStep`, `RemoteStepDef`, inline `ctx.step(name, closure)` outright (breaking 0.x cut, consistent with Phase 2).
- **Fresh-dist typecheck rule (load-bearing).** `tsc` typechecks against built dep dist. After changing a package that others depend on, `pnpm --filter <pkg> build` BEFORE typechecking/downstream tasks, or renamed-symbol breaks stay masked. Order: core → worker → nestjs/transport/store/dashboard.
- **`Symbol.for` for cross-package metadata.** The `@Step` name-stamp symbol MUST be `Symbol.for('durable.step.name')` (not a plain `Symbol()`), so a duplicate core instance can't break the read (same discipline as the `STATE_STORE` Symbol.for fix).
- **Style:** `function foo()` not arrow consts; avoid `as`/`any`/`unknown`/`never`; fixed exact dep versions; no Co-Authored-By; commit locally, NO push/publish.
- **Full gate each task:** the package's vitest + `tsc --noEmit` (against fresh dist) + `biome check`.

---

### Task 1: core — `StepDef`, name-stamp symbol, drop `remoteStep`/`RemoteStepDef`

**Files:**
- Modify: `packages/core/src/interfaces.ts` (WorkflowCtx surface + `StepDef`)
- Delete: `packages/core/src/remote-step-factory.ts` (the `remoteStep()` factory + `RemoteStepConfig`)
- Create: `packages/core/src/step-name-symbol.ts` (the shared stamp)
- Modify: `packages/core/src/index.ts` (exports: drop `remoteStep`/`RemoteStepDef`, add `StepDef`, `DURABLE_STEP_NAME`, `stepNameOf`)
- Test: `packages/core/src/step-name-symbol.spec.ts`

**Interfaces:**
- Produces:
  - `DURABLE_STEP_NAME = Symbol.for('durable.step.name')`.
  - `type StepRef<I, O> = ((input: I) => Promise<O> | O) & { [DURABLE_STEP_NAME]?: string }` — a method carrying its stamped routing name.
  - `function stepNameOf(ref: unknown): string | undefined` — reads the stamp off a function ref (returns `undefined` for a non-stamped value).
  - `type StepDef<I, O>` retained ONLY as the structural `{ name: string }` carrier the engine/gather reference internally (rename of `RemoteStepDef`); the public `remoteStep()` factory is gone.
  - `WorkflowCtx.step` overloads (dispatched, replaces `remote`):
    - `step<I, O>(handler: StepRef<I, O>, input: I, opts?: StepDispatchOpts): Promise<O>`
    - `step<O = unknown>(name: string, input: unknown, opts?: StepDispatchOpts): Promise<O>`
    where `StepDispatchOpts = { queue?: string; priority?: number; fairnessKey?: string; transport?: string }`.
  - `WorkflowCtx.now(): Promise<string>` (ISO-8601, replay-stable) and `WorkflowCtx.uuid(): Promise<string>` (replay-stable).
  - REMOVED from `WorkflowCtx`: `remote(...)`, the inline `step(name, fn, options)`.
- Consumes: nothing (foundational task).

- [ ] **Step 1: Write the failing test** — `step-name-symbol.spec.ts`:
```ts
import { DURABLE_STEP_NAME, stepNameOf } from './step-name-symbol';
import { describe, expect, it } from 'vitest';

describe('step name stamp', () => {
  it('reads a stamped name off a function ref', () => {
    function handler() {}
    (handler as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = 'Svc.handler';
    expect(stepNameOf(handler)).toBe('Svc.handler');
  });
  it('returns undefined for an unstamped value or a plain string', () => {
    expect(stepNameOf(() => {})).toBeUndefined();
    expect(stepNameOf('Svc.handler')).toBeUndefined();
  });
  it('uses the global registry symbol (survives duplicate module copies)', () => {
    expect(DURABLE_STEP_NAME).toBe(Symbol.for('durable.step.name'));
  });
});
```

- [ ] **Step 2: Run it, verify it fails** (`pnpm --filter @dudousxd/nestjs-durable-core test step-name-symbol` → module not found).
- [ ] **Step 3: Implement** `step-name-symbol.ts` (the symbol + `stepNameOf`), then rename `RemoteStepDef`→`StepDef` in `interfaces.ts`, delete `remote-step-factory.ts`, update `WorkflowCtx` (`step` dispatched overloads, remove `remote` + inline `step`, add `now`/`uuid`), fix `index.ts` exports.
- [ ] **Step 4: Run core test + typecheck** (`pnpm --filter @dudousxd/nestjs-durable-core test`, then `pnpm --filter @dudousxd/nestjs-durable-core build`, then `pnpm --filter @dudousxd/nestjs-durable-core typecheck`). Expect the interface change to surface downstream breaks in LATER tasks, not here.
- [ ] **Step 5: Commit** (`git add packages/core/src/{interfaces,index,step-name-symbol}.ts packages/core/src/step-name-symbol.spec.ts` and the deleted factory; commit `feat(core)!: single ctx.step surface + step-name stamp; drop remoteStep/RemoteStepDef`).

---

### Task 2: worker — `ctx.step` (dispatched) + `now`/`uuid`, drop inline `step`/`remote`

**Files:**
- Modify: `packages/worker/src/workflow-context.ts`
- Test: `packages/worker/src/workflow-context.spec.ts` (+ existing gather/step specs)

**Interfaces:**
- Consumes: T1's `StepRef`/`stepNameOf`/`StepDef`, `DURABLE_STEP_NAME`.
- Produces: `WorkflowContext.step(refOrName, input, opts?)` — resolves the routing name via `typeof arg === 'string' ? arg : stepNameOf(arg)` (throw a clear error if a passed ref has no stamp), then runs the EXACT body today's `remote` runs (replay `call`/seq → else push `{kind:'call',...}` + `throw Suspend`). `now()`/`uuid()` reuse `runStepBody` with a synthetic replay-stable name (`now#<seq>` / `uuid#<seq>`), recording a `recordStep`. `gather` element type follows `StepDef`. The old public `step(name, closure)` and `remote(...)` are removed; `runStepBody` stays (now/uuid/transaction/gather).

- [ ] **Step 1: Write failing tests** — in `workflow-context.spec.ts`:
```ts
it('ctx.step(ref, input) dispatches by the stamped name (same decision as old remote)', async () => {
  function runPage(_i: { page: number }) { return Promise.resolve({ nextPage: null }); }
  (runPage as any)[DURABLE_STEP_NAME] = 'Extraction.runPage';
  const ctx = /* fresh replay ctx, empty history */;
  await expect(ctx.step(runPage, { page: 1 })).rejects.toBeInstanceOf(Suspend);
  expect(ctx.drainCommands()).toEqual([
    { kind: 'call', seq: 0, name: 'Extraction.runPage', group: /* workflow partition */ '', input: { page: 1 } },
  ]);
});
it('ctx.step("name", input) dispatches by string (cross-runtime form)', async () => { /* same, name passed literally */ });
it('ctx.step(ref) throws a clear error when the ref carries no @Step stamp', async () => {
  await expect(ctx.step(() => 1 as any, {})).rejects.toThrow(/not a @Step|no step name/i);
});
it('ctx.now()/uuid() record once and replay the captured value', async () => { /* first run records recordStep; replay returns cached */ });
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the rename + name resolution + `now`/`uuid`; delete old `remote`/inline-`step`.
- [ ] **Step 4: Gate** (`pnpm --filter @dudousxd/nestjs-durable-core build` first, then worker test + build + typecheck). Migrate this package's own specs that used `.remote`/inline `.step`.
- [ ] **Step 5: Commit** `feat(worker)!: ctx.step dispatched form + now/uuid; drop inline step + remote`.

---

### Task 3: nestjs — `@Step()` name derivation, optional zod, stamp; registrar + ctx wiring

**Files:**
- Modify: `packages/nestjs/src/decorators.ts` (or wherever `@Step` lives)
- Modify: `packages/nestjs/src/durable-step.registrar.ts`
- Modify: any nestjs `ctx`/executor code binding step handlers
- Test: `packages/nestjs/src/step-decorator.spec.ts`

**Interfaces:**
- Consumes: T1 `DURABLE_STEP_NAME`, `stepNameOf`.
- Produces: `@Step()` (bare) stamps `descriptor.value[DURABLE_STEP_NAME] = \`${target.constructor.name}.${propertyKey}\``; `@Step('custom:name')` overrides; `@Step({ name?, input?: ZodType, output?: ZodType })` overrides name + attaches optional runtime schemas (validated at the dispatch boundary — input on serve, output on return). `DurableStepRegistrar` registers under the derived name (was the explicit string). The registry discovery keeps working with derived names.

- [ ] **Step 1: Write failing tests** — `@Step()` derives `Class.method`; `@Step('x')` overrides; `@Step({input,output})` attaches schemas; a `ctx.step(instance.method, input)` end-to-end (fake transport) routes to the derived-name handler.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** decorator + registrar; wire optional zod validation on the serve/return boundary (skip when absent).
- [ ] **Step 4: Gate** (build core+worker first, then nestjs test/build/typecheck).
- [ ] **Step 5: Commit** `feat(nestjs)!: @Step name derivation + optional zod; ctx.step method-ref routing`.

---

### Task 4: sweep dependent packages (transport-bullmq, store-mikro-orm, dashboard, admission-redis, otel, telescope)

**Files:** any `packages/*/src/**` referencing `RemoteStepDef`, `remoteStep`, `.remote(`, or the inline `ctx.step(name, closure)`.

**Interfaces:** Consumes T1-T3. Produces: green typecheck across all non-test package sources.

- [ ] **Step 1:** `grep -rln "remoteStep\|RemoteStepDef\|\.remote(" packages/*/src` (exclude core/worker/nestjs already done). List the hits.
- [ ] **Step 2:** For each, mechanically migrate to `StepDef` / `ctx.step`. No behavior change.
- [ ] **Step 3: Gate** — build the chain, then `pnpm -r typecheck` for these packages.
- [ ] **Step 4: Commit** `refactor!: migrate dependent packages to single ctx.step surface`.

---

### Task 5: tests + conformance sweep

**Files:** `packages/*/src/**/*.spec.ts`, `packages/testing/src/**` (conformance harness), `examples/**` if compiled by tests.

**Interfaces:** Consumes T1-T4. Produces: full `pnpm -r test` + `pnpm -r typecheck` + `biome check` green.

- [ ] **Step 1:** Run `pnpm -r test` to enumerate failures from the surface change.
- [ ] **Step 2:** Migrate every `.remote(`, inline `ctx.step(name, closure)`, `remoteStep(...)`, `RemoteStepDef` in specs/conformance to the new surface (method-ref where a handler exists, string otherwise; inline captures → `ctx.now`/`ctx.uuid` or a `@Step`). Preserve each test's intent.
- [ ] **Step 3: Gate** — `pnpm -r test && pnpm -r typecheck && pnpm -r biome check` (or the repo's `check-all`).
- [ ] **Step 4: Commit** `test!: migrate suite + conformance to single ctx.step surface`.

---

### Task 6: Python `durable-worker` parity

**Files:** `clients/python/durable_worker/**` (`workflow_context.py`, decorator, `worker.py`), Python tests.

**Interfaces:** Mirrors the agreed contract on the SAME wire. Produces: `.step(name, input)` (was `.call`), `.now()`/`.uuid()`, a `@step`-style decorator deriving the name, `.call` removed.

- [ ] **Step 1: Write failing tests** — `.step("name", input)` emits the same `call` decision `.call` did; `.now()`/`.uuid()` record + replay; a decorated handler registers under its derived name.
- [ ] **Step 2: Run, verify fail** (`pytest clients/python`).
- [ ] **Step 3: Implement** rename + helpers + decorator; remove `.call`.
- [ ] **Step 4: Gate** — `pytest clients/python`.
- [ ] **Step 5: Commit** `feat(python)!: ctx.step + now/uuid; drop call`.

---

### Task 7: docs + examples + changesets

**Files:** `examples/**`, `README.md`, `docs/**` in the lib, `.changeset/*.md`.

**Interfaces:** Consumes T1-T6. Produces: docs describe the single `ctx.step`; a changeset (minor, since 0.x) for `core`/`worker`/`nestjs`/`durable-worker` capturing the breaking surface; Python version bump note.

- [ ] **Step 1:** Rewrite examples/READMEs to `ctx.step(this.svc.method, input)` + `ctx.now()`/`ctx.uuid()`; explain the string form for cross-runtime + `ctx.child` for cross-runtime workflows.
- [ ] **Step 2:** Add `.changeset/durable-single-step.md` (minor bump, breaking-in-0.x note listing the removed symbols).
- [ ] **Step 3: Gate** — `pnpm -r build && pnpm -r typecheck` (examples compile).
- [ ] **Step 4: Commit** `docs!: single ctx.step surface + changeset`.

---

### Task 8: flip-nestjs migration (downstream, LOCAL-TEST-ONLY — do NOT commit beta pins to flip master)

**Files (flip repo `/home/dudousxd/goflipai/flip-nestjs`):** `src/durable/pipeline.workflow.ts`, `src/defense/us/listener/extraction-step.service.ts`, `src/durable/*.service.ts` doc comments.

**Interfaces:** Consumes the published beta (bumped after T1-T7). Produces a flip that reads `ctx.step(this.extraction.runExtractionPage, …)` + `ctx.now()` + `ctx.child`.

- [ ] **Step 1:** `@Step()` on `ExtractionStepService.runExtractionPage`; delete `extractionPageStep`/`remoteStep` import in `pipeline.workflow.ts`; inject `ExtractionStepService` into `PipelineWorkflow`.
- [ ] **Step 2:** `ctx.remote(extractionPageStep, …)` → `ctx.step(this.extraction.runExtractionPage, { page, key, … })`.
- [ ] **Step 3:** `ctx.step("extraction:setup", … new Date() …)` → `const now = await ctx.now()`; side-effect closures (`bust-base-cache`, `mark-task-error`, `alert-on-call`) → `@Step` methods called via `ctx.step(this.svc.method, input)`. Keep `processing`/ingestion on `ctx.child`.
- [ ] **Step 4: Gate** — flip `build → codegen → typecheck:inertia` + prod-mode boot smoke. Keep uncommitted.

---

## Self-Review notes
- Spec coverage: T1-T3 = the `ctx.step`/`@Step`/helpers core change; T4-T5 = ripple + tests; T6 = Python; T7 = docs/changeset; T8 = flip. `ctx.transaction` intentionally untouched (spec: stays in-process).
- Parallelization: T1 first (foundational). T6 (Python) can run in PARALLEL from the start (contract-frozen). After T2 builds, T3/T4 parallelize. T5 gates on T1-T4. T7/T8 last.
- Wire frozen — no task edits the decision/history protocol (Global Constraints).
