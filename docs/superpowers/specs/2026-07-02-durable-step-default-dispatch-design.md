# Durable single-step redesign (`@Step` + `ctx.step`)

**Status:** design — approved
**Date:** 2026-07-02
**Phase:** 3 (breaking, 0.x) — follows route-by-handler (Phase 1) and unified-module (Phase 2).

## Problem

The north star was **one durable step primitive** — "you just call it, it's durable, you don't think
about placement." Phases 1-2 shipped the opposite: two co-equal verbs where the **author** picks
placement by hand — `ctx.step(name, closure)` (inline, in-process) vs `ctx.remote(def, input)`
(dispatched by handler name). The ergonomic default (`step`) went to the *narrower* local case, and the
durable engine-placed case got the explicit `remote` name. Every workflow author carries a
placement decision that shouldn't exist.

## Decision

**One `ctx.step`. Always durable, always engine-scheduled (dispatched by handler name).** No inline
variant, no `remote`, no author-facing placement choice. A step is a `@Step`-decorated method; you call
it by **reference** (typed) or by **name** (cross-runtime). Crossing a *workflow* boundary stays
`ctx.child`.

### The `@Step` decorator carries the identity

`@Step()` derives the routing name from the method (`Class.method`), so there's no magic string linking
a def to a handler:

```ts
@Injectable()
class ExtractionService {
  @Step()                          // name = "ExtractionService.runExtractionPage"
  async runExtractionPage(input: { page: number; key: string }) {
    /* fetch one DoD page, append to S3, return { records, nextPage } */
  }
}
```

Optional forms:
- `@Step("custom:name")` — explicit name override (stable across refactors / cross-runtime contracts).
- `@Step({ name?, input?: ZodType, output?: ZodType })` — opt-in **runtime validation** at the
  dispatch boundary. Bare `@Step()` gives compile-time types from the method signature only; a step
  that crosses into an untyped wire (a Python worker) should carry `input`/`output` schemas.

### Two call forms — reference and string

```ts
// JS handler → pass the method reference. Name comes from @Step; input/output inferred from the
// method signature (no zod def to write). Refactor-safe, autocompleted.
const r = await ctx.step(this.extraction.runExtractionPage, { page, key });

// Cross-runtime handler (a Python @Step) → there is no JS reference to import, so name it by string.
const out = await ctx.step<ProcResult>("processing:proc", input);
```

Both forms emit the identical dispatch — the reference is sugar that reads the stamped name. A step's
body runs on whatever worker serves that name (this process's co-located worker, another pool, or
another runtime); the reference form is simply unavailable for code that lives in another language,
which is expected (you can't import a Python function into TS). Steps on **other classes** work the
same way — `ctx.step(this.otherWorkflow.someStep, input)` reads that method's stamped name and
dispatches, so a workflow can call another workflow's steps by reference.

### Deterministic captures: `ctx.sideEffect(fn)` + `ctx.now()`

Because every step is dispatched, forcing a `new Date()` / `uuidv7()` through a `@Step` + Redis
round-trip is overkill. Non-deterministic captures get a general in-process primitive:

- **`ctx.sideEffect(fn)`** — run `fn` once, checkpoint its result, and on replay return the SAME
  value WITHOUT re-running `fn` (Temporal's `sideEffect`). The author controls the generator:
  `ctx.sideEffect(() => uuidv7())`, `() => ulid()`, `() => Math.random()`, a config/env read. `fn`
  must be effectively pure (produces a value; not re-run on replay) — real side effects (a DB write,
  an API call) are a `ctx.step`.
- **`ctx.now()`** — epoch **ms** (like `Date.now()`), the one ubiquitous convenience (single obvious
  implementation), kept so a timestamp doesn't need a `sideEffect` closure. For an ISO string:
  `new Date(await ctx.now()).toISOString()`.

No baked `ctx.uuid()`/`ctx.random()` — the algorithm is exactly what the author should choose, so those
are `ctx.sideEffect(() => …)`. So `@Step` is reserved for real dispatched work; captures use
`sideEffect`/`now`.

### What survives as in-process (by necessity, not as a placement choice)

- **`ctx.transaction(name, fn)`** — the exactly-once DB step runs `fn` with the store's **native
  transaction handle**, which is not serializable/portable; it is inherently in-process. It stays as a
  distinct, self-describing DB primitive (not the local/remote *step* split this redesign kills).
- `ctx.child`, `ctx.task`, `ctx.callEntity`/`signalEntity`, `ctx.sleep`/`sleepUntil`,
  `ctx.waitForSignal`/`waitForEvent`, `ctx.continueAsNew`, `ctx.gather`/`all` — unchanged.

## Removed (no deprecation aliases — breaking cut, consistent with Phase 2)

- `ctx.remote` → `ctx.step`.
- `ctx.step(name, closure)` (the old inline form) → gone. Side-effect closures become `@Step` methods;
  trivial captures become `ctx.now()`/`ctx.uuid()`.
- `remoteStep({ … })` factory and `RemoteStepDef` type → gone (identity now lives on the `@Step`
  method; there is nothing to declare separately).

## Scope: authoring surface + `@Step` metadata — the wire is untouched

The cross-SDK decision/history protocol stays byte-identical. `ctx.step` (new) emits the same
`{ kind: 'call', seq, name, group, input }` decision and `throw new Suspend()` that `ctx.remote` emits
today (workflow-context.ts:215-226); route-by-handler, partitioning, convention dispatch, lease renewal
during a turn, and `gather` fan-out are unchanged. What changes: the authoring methods, the `@Step`
decorator (name derivation + optional schemas + a shared name-stamp symbol readable by core's
`ctx.step`), and the two new ctx helpers. Keeping the wire stable is what de-risks the cut — no
JS-engine ↔ Python-worker renegotiation.

### Core vs NestJS layering

The method-**reference** form is NestJS-layer sugar (it depends on `@Step` stamping a shared symbol
that core's `ctx.step` reads). Framework-agnostic core keeps the **string** form as the universal
entry (`ctx.step("name", input)`); the worker's existing name-based registration is how a non-Nest
handler is served. So `ctx.step` accepts `(handlerRef | name, input, opts?)`.

## Python parity

Mirror in `durable-worker`'s `WorkflowContext`:
- `.step(name, input)` — dispatched (today's `.call`). Python has no natural method-reference, so it
  uses the string/decorator-name form; a Python `@step`-style decorator derives the name symmetrically.
- `.now()` / `.uuid()` helpers to match.
- `.call` removed.

Bump `durable-worker` (breaking). The fleet (engine + JS/Python workers) adopts together, as every
prior routing/surface cut required.

## Downstream: flip

flip lands on exactly the target model — no `remote`, no placement bookkeeping:

- `ctx.remote(extractionPageStep, …)` → `ctx.step(this.extraction.runExtractionPage, { page, key })`
  (the `remoteStep` def in `pipeline.workflow.ts` is deleted; identity moves to the `@Step()` on
  `ExtractionStepService.runExtractionPage`).
- `ctx.step("extraction:setup", () => ({ key, cutoffDate: new Date().toISOString() }))` → the timestamp
  becomes `const now = await ctx.now()`; the key is pure from `baseId`/`type`/`now`.
- The side-effect closures — `ctx.step("bust-base-cache", …)`, and the `@DeadLetter` handler's
  `ctx.step("mark-task-error", …)` / `ctx.step("alert-on-call", …)` → `@Step` methods called via
  `ctx.step(this.svc.method, input)`.
- `processing` and ingestion stay `ctx.child` (sub-workflows, incl. the cross-runtime Python one).

Reads as: **`ctx.step(this.svc.method, …)` for durable work, `ctx.now()`/`ctx.uuid()` for captures,
`ctx.child` for sub-workflows.** (flip changes stay local-test-only until the fleet ships together.)

## Non-goals

- No wire/history/protocol change (see Scope).
- No change to `gather`, `transaction`, `task`, `child`, entity/signal/timer surfaces (only `gather`'s
  element type follows the step rename).
- No deprecation-alias layer.

## Risks

- **Broad, shallow churn:** touches every workflow author (lib examples, tests, conformance, flip,
  Python). Mechanical but wide — the fresh-dist typecheck rule from Phases 1-2 applies (rebuild core
  before typechecking downstream, or renamed-symbol breaks stay masked).
- **`@Step` name-stamp reachability:** core's `ctx.step` must read a name off a method the NestJS
  `@Step` decorator stamped — needs a shared `Symbol.for`-keyed metadata contract (same discipline as
  the `STATE_STORE` Symbol.for fix) so a duplicate core instance can't break the read.
- **Reference form + `this`:** `ctx.step(this.svc.method, input)` passes an unbound method; `ctx.step`
  must route by the *stamped name only* and never invoke the reference directly (the serving worker
  re-resolves the handler from DI), so an unbound `this` is irrelevant — but a test must lock this in.
