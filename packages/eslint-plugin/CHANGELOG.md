# @dudousxd/nestjs-durable-eslint-plugin

## 0.4.0

### Minor Changes

- 988ec4c: Collapse the local/remote step split into ONE durable step primitive (breaking, 0.x).

  - **One `ctx.step`, always dispatched, always engine-scheduled.** `ctx.step(handlerRef | name, input, opts?)` is the only step primitive — no author-facing placement choice. Pass a `@Step`-decorated method **reference** (name + types read off the stamped method — refactor-safe, autocompleted) or a **name string** for a cross-runtime handler (e.g. a Python `@step`). Both forms emit the identical dispatch; a step runs on whatever worker serves that name. Crossing a _workflow_ boundary is unchanged — still `ctx.child`.
  - **`@Step` carries the identity.** `@Step()` derives the routing name from the method (`Class.method`); `@Step('custom:name')` overrides it; `@Step({ name?, input?, output?, retries?, backoff?, backoffMs?, backoffMaxMs?, jitter?, timeoutMs? })` adds opt-in runtime zod validation and a **declared retry/timeout policy** the engine applies to every dispatch of that step. `StepDispatchOpts` (the per-call `ctx.step(..., opts)` third argument) can override any of `retries`/`backoff`/`backoffMs`/`backoffMaxMs`/`jitter`/`timeoutMs` field-by-field on top of the `@Step`-declared value, plus the existing `queue`/`priority`/`fairnessKey`/`transport`.
  - **New deterministic-capture primitives.** `ctx.sideEffect(fn)` runs `fn` once, checkpoints the result, and replays the SAME value thereafter (Temporal's `sideEffect`) — the author picks the generator: `ctx.sideEffect(() => uuidv7())`, `() => ulid()`, `() => Math.random()`, a config/env read. `ctx.now()` returns epoch **ms** (like `Date.now()`), the one ubiquitous convenience kept as a lightweight built-in.
  - **Removed, no deprecation aliases:** `ctx.remote` (→ `ctx.step`), the inline `ctx.step(name, closure)` form (→ a `@Step` method dispatched via `ctx.step(this.svc.method, input)`, or `ctx.sideEffect`/`ctx.now()` for a non-dispatched capture), `remoteStep()` and `RemoteStepDef` (identity now lives on the `@Step` method itself — nothing to declare separately), `ctx.uuid()` and `ctx.random()` (→ `ctx.sideEffect(() => ...)`, so the algorithm is exactly what the author chooses). `@DurableStep` stays as a back-compat alias of `@Step` (unaffected).
  - **`@dudousxd/nestjs-durable-eslint-plugin` / the GritQL rule** flag differently: a closure is only treated as checkpointed inside `ctx.sideEffect(...)`/`ctx.task(...)` now (no longer `ctx.step(...)`, which never takes a closure), and the `useRandom`/`useUuid` messages point at `ctx.sideEffect(() => ...)` instead of the removed `ctx.random()`/`ctx.uuid()`.

  No wire/history/protocol change — `ctx.step` emits the same `{ kind: 'call', seq, name, group, input }` decision and `Suspend` that `ctx.remote` emitted, so route-by-handler, partitioning, convention dispatch, and `gather`/`all` fan-out are unchanged; only the authoring surface moved. The durable fleet (engine + JS/Python workers) adopts the new surface together, as every prior routing/surface cut required. Python's `durable-worker` (PyPI) gets the same cut — `.step(name, input)` always dispatched, `.now()`/`.side_effect(fn)` added, `.call`/baked uuid/random removed — bumped separately on PyPI, not through this changeset.

## 0.3.0

### Minor Changes

- 687face: Ecosystem improvements across the durable runtime, stores, transports, and tooling.

  ### Scheduling

  - **Schedule jitter + backfill.** Cron/interval schedules can now spread fire
    times with configurable jitter to avoid thundering-herd dispatch, and missed
    occurrences (e.g. while a worker was down) can be backfilled deterministically.

  ### Cancellation

  - **Cancel-by-event.** New `cancelWhere(filter)` cancels all matching runs by a
    declarative filter, complementing single-run cancellation.

  ### Search attributes

  - **Indexed search-attribute side-table pushdown.** Equality and range queries
    over search attributes are pushed down into an indexed side-table across every
    store — TypeORM, MikroORM, Prisma, Drizzle, and the in-memory store — instead
    of scanning and filtering in application code. The side-table is re-indexed on
    update so stale attribute values stop matching.

  ### Singleton admission

  - **Backpressure + notify-on-release + `maxQueueDepth`.** Singleton admission now
    applies backpressure with a configurable `maxQueueDepth`, and waiters are
    notified on release rather than polling.

  ### Queue

  - **Priority + per-key fairness.** The work queue supports per-message priority
    together with per-key fairness so that one busy key cannot starve others.

  ### Context propagation

  - **Opaque context carrier.** Context is now propagated through an opaque carrier,
    decoupling callers from the underlying transport/trace representation.

  ### Packaging

  - **Dual ESM/CJS publish.** Packages now ship both ESM and CJS builds. Decorator
    packages are built via SWC with `legacyDecorator` + `decoratorMetadata` to
    preserve emitted metadata; `testing`, `cli`, and `eslint-plugin` remain
    CJS/ESM as appropriate by design.

  ### Testing

  - **Testcontainers-backed integration specs.** BullMQ, SQS, DB, and Prisma now
    have testcontainers-backed integration specs that run under `test:db`, plus a
    fix to the BullMQ dispatch test shape.

## 0.2.1

### Patch Changes

- b1dc075: fix: don't flag non-determinism inside a ctx.step / ctx.task callback

  A `ctx.step(...)` / `ctx.task(...)` body runs once and is checkpointed, so `new Date()` /
  `Math.random()` there is replay-safe — only the orchestration body must be deterministic. Both the
  ESLint rule (it now stops at a step/task callback boundary before reaching `run`) and the Biome
  GritQL plugin (`not within \`$_.step($...)\``) now exclude those, so a workflow that does its
  non-deterministic work inside steps lints clean.

## 0.2.0

### Minor Changes

- b24b915: feat: lint for non-determinism inside a @Workflow run (ESLint + Biome)

  A new package, `@dudousxd/nestjs-durable-eslint-plugin`, with a `no-nondeterminism` rule that flags
  `Date.now()` / `Math.random()` / `new Date()` / `crypto.randomUUID()` / `performance.now()` used
  inside a `@Workflow` `run` — they differ across replays and silently corrupt a durable run; use the
  checkpointed `ctx.now()` / `ctx.random()` / `ctx.uuid()`. The ESLint rule is AST-scoped to the
  workflow body; the package also ships a Biome (>= 2.0) GritQL plugin (`grit/no-nondeterminism.grit`)
  for Biome users, targeted at workflow files via `overrides`.
