# Durable step default-dispatch redesign

**Status:** design
**Date:** 2026-07-02
**Phase:** 3 (breaking, 0.x) — follows the route-by-handler (Phase 1) and unified-module (Phase 2) cuts.

## Problem

The original north star for this redesign was **one durable step primitive that is durable-by-default
with engine-scheduled placement**, cross-service being the explicit exception — "you just call it and
it works." What Phases 1-2 actually shipped inverted that: two co-equal authoring verbs where the
**author** picks placement by hand.

Today:

- `ctx.step(name, closure)` — runs the closure **inline, in-process**, does not suspend, continues the
  turn. The effortless-looking name went to the *local* case.
- `ctx.remote(stepDef, input)` — **dispatches by handler name and suspends** (route-by-handler). The
  durable, engine-placed case — the one that should have been the default — got the explicit name.

So the mental model an author carries is "decide, per call, whether this runs here or over there," and
the ergonomic default (`step`) is the *narrower* capability (local only). This is backwards from the
goal, and it leaks placement into everyday workflow code that shouldn't care.

## Decision

Invert the surface so the **default is the durable, engine-scheduled step**, and *inline* is the named
exception:

| Today | After |
| --- | --- |
| `ctx.remote(def, input, opts)` | **`ctx.step(def, input, opts)`** — the default: durable, dispatched by handler name, suspends, checkpointed. Cross-runtime (a Python `@Step`) is the same call. |
| `ctx.step(name, closure, opts)` | **`ctx.localStep(name?, closure, opts)`** — the exception: run a closure in-process once, checkpoint its result. For cheap deterministic capture (timestamps, ids, small transforms) where a dispatch is overkill. |
| `remoteStep({ name, input, output })` factory | **`step({ name, input, output })`** factory — declares a typed dispatched-step def. |
| `RemoteStepDef<I, O>` type | **`StepDef<I, O>`** |
| `ctx.remote` / `remoteStep` / `RemoteStepDef` | **removed** (no deprecation aliases, consistent with the Phase-2 cut). |

Everything else on `WorkflowCtx` keeps its name and semantics: `transaction` (inline, exactly-once DB
step — self-describing, stays), `task`, `child`, `gather`, `sleep`/`sleepUntil`, `waitForSignal`/
`waitForEvent`, `callEntity`/`signalEntity`, `continueAsNew`. Only the step/remote pair inverts.

### Why default-dispatch (not engine-auto-placement)

A rejected alternative was "one `step` where the engine runs it inline if the handler is registered in
this process, else dispatches." It reads simplest, but placement becomes **implicit and
deployment-dependent**: the same step runs inline in one topology and dispatched in another, with
different retry/concurrency/failure characteristics, and "where did this run?" has no stable answer.
Default-dispatch keeps the durable unit **uniform and predictable** — every `ctx.step` is a real
scheduled checkpoint with the same guarantees everywhere — which is what "durable-by-default,
engine-scheduled placement" actually means. `localStep` is the deliberate opt-out for work too cheap
to schedule. (This mirrors Temporal's activity-vs-workflow-code split.)

## Scope: authoring surface only — the wire is untouched

This is a **rename of the authoring API**, not a protocol change. The cross-SDK decision/history
protocol stays byte-identical:

- The wire decision kind stays `call`; history event kinds are unchanged.
- `ctx.step` (new) emits the same `{ kind: 'call', seq, name, group, input }` decision and `throw new
  Suspend()` that `ctx.remote` emits today (workflow-context.ts:215-226).
- `ctx.localStep` (new) keeps the exact `runStepBody` → `recordStep` inline path that `ctx.step` runs
  today (workflow-context.ts:252-264), including the `StepLogger`.
- Replay, lease renewal (the background `setInterval(renewRunLock)` during a turn), route-by-handler,
  partitioning, convention dispatch, `gather` fan-out — all unchanged.

Keeping the wire stable is what makes this low-risk: no JS-engine ↔ Python-worker protocol
renegotiation, only the strings authors type.

## Open naming defaults (confirm in review)

1. **Factory name `step({...})`** vs `defineStep({...})`. Recommendation: `step()` — symmetric with the
   old `remoteStep()`/`ctx.remote` pairing (`step()` def import + `ctx.step()` method; different
   namespaces, no collision). `defineStep()` is the safer-if-noisier alternative.
2. **`localStep` name argument optional.** Recommendation: optional, defaulting to a seq-derived label
   (`local#<seq>`), which is replay-stable because seq is deterministic; pass an explicit name for a
   readable dashboard timeline. (Matches the "just a closure" ergonomics; the nondeterminism guard is
   satisfied either way.)
3. **`@Step("name")` decorator stays.** It registers the handler a `ctx.step(def)` dispatches to —
   unchanged.

## Python parity

Mirror the inversion in `durable-worker`'s `WorkflowContext`:

- `.step(def_or_name, input)` — dispatched (today's `.call`).
- `.local_step(fn, name=None)` — inline (today's `.step`).
- `.call` removed.

Bump `durable-worker` (breaking). The fleet — engine + JS workers + Python workers — adopts together,
as every prior routing/surface cut already required.

## Downstream: flip

flip ends up with **no `remote` anywhere**, exactly the target model:

- `ctx.remote(extractionPageStep, …)` → `ctx.step(extractionPageStep, …)` (dispatched, unchanged
  behavior — each DoD page is still a scheduled checkpoint).
- `remoteStep({ name: "extraction:page", … })` → `step({ name: "extraction:page", … })`.
- The cheap inline closures — `ctx.step("extraction:setup", …)`, `ctx.step("bust-base-cache", …)`, and
  the `@DeadLetter` handler's `ctx.step("mark-task-error"/"alert-on-call", …)` → `ctx.localStep(…)`.
- `processing` and ingestion stay `ctx.child` (sub-workflows, incl. the cross-runtime Python one).

Result reads as the vision intended: **`ctx.step` for real durable work, `ctx.localStep` for trivial
inline capture, `ctx.child` for sub-workflows** — no placement bookkeeping.

## Non-goals

- No wire/history/protocol change (see Scope).
- No change to `gather` semantics — only its input type renames (`RemoteStepDef` → `StepDef`).
- No deprecation-alias layer (breaking cut; fleet migrates together).
- No change to `transaction`/`task`/`child`/entity/signal/timer surfaces.

## Risks

- **Broad, shallow churn:** the rename touches every workflow author (lib examples, tests, conformance,
  flip, Python). Mechanical, but wide — the fresh-dist typecheck rule from Phases 1-2 applies (rebuild
  core before typechecking downstream, or renamed-symbol breaks stay masked).
- **`step` overload clarity:** `ctx.step` becomes solely the `(def, input)` form (no closure overload),
  so there is no ambiguous signature — but reviewers should confirm no lingering `ctx.step(name, () =>
  …)` call sites survive un-migrated (they'd now be a type error, which is the safety net).
