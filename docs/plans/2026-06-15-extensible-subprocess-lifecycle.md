# Extensible sub-process lifecycle (run identity + open phases)

**Date:** 2026-06-15
**Status:** Design — pending review
**Packages:** `core`, `dashboard` (lib). Consumers touched: `flip-python-db`, `flip-nestjs` (bump only).

## Problem

A step that fans out into many sub-processes (e.g. flip's `processing` step runs N dependent
"p-processes") currently reports each sub-process as a single terminal outcome:

```ts
ctx.sub(name, 'ok' | 'failed' | 'skipped', message?, data?)
```

and tags a step's log lines with the **name** of the owning sub-process (`StepEvent.process`). The
dashboard groups the step's events by that name.

Two limitations surface in practice:

1. **No lifecycle.** A sub-process is just a terminal dot. There's no way to express that it moved
   through stages over time (dispatched → validating → processing → done), nor to show a per-stage
   timeline or a duration. A consumer with a real lifecycle (flip's `TRIGGERED → VALIDATING →
   PROCESSING → COMPLETED`) cannot represent it.

2. **Name-only identity collapses distinct runs.** Because a sub-process is keyed by `name`, two
   genuinely-distinct runs of the same name (the same proc invoked under two different lanes, or the
   same proc run twice) collapse into one row and their log trails pile up under a single label. In
   flip's `/durable`, `ProcessKpi` appears once with its internal log trail repeated ~4×, because
   `ProcessKpi` ran four times across lanes and every run's logs landed on the `process: "ProcessKpi"`
   tag.

We want the dashboard to render each sub-process as an **expandable row** — click it, see its own
lifecycle timeline, duration, terminal status, error, and the log lines that run emitted — matching
the per-process expand UX flip already has in its v1 `pipeline-runs` screen. But the library must
stay generic: it cannot learn flip's vocabulary (`TRIGGERED`/`VALIDATING`/…). The lifecycle stages
must be **consumer-defined**, while the library keeps a small canonical set of terminal outcomes for
consistent colouring and aggregation.

## Design decisions (settled)

- **Two dimensions, separated.**
  - **Terminal status** — closed enum owned by the lib: `ok | failed | skipped`. Drives colour and
    the `N ok / M failed` aggregation. The lib must own this so counts are always meaningful.
  - **Phase** — an **open string** supplied by the consumer. The lib timestamps, orders, and renders
    phases; it never interprets them. This is the extension point.
- **Run identity.** A sub-process invocation has a stable **`id`**, distinct per invocation. Distinct
  runs of the same `name` get distinct ids, so their phases and logs never collapse.
- **Open grouping.** A sub-process may carry an open **`group`** label (consumer-defined, e.g. flip's
  handler/lane). The dashboard groups rows by it, mirroring the v1 "Handler Summary" + per-run
  accordion. Optional, like `phase`.
- **Discrete live events.** Each phase transition is its own event, emitted as it happens, so the
  dashboard shows a stage in flight (it already merges `step.progress` into the cached step events —
  no new transport). This is preferred over bundling a finished lifecycle into one terminal event.
- **Backward compatible.** Existing `ctx.sub(name, status)` callers keep working unchanged and render
  exactly as today. New identity/phase/group fields are all optional.

## Data model (`core`)

Extend `StepEvent` (in `packages/core/src/interfaces.ts`). New fields are additive and optional:

```ts
export interface StepEvent {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;

  // --- sub-process identity ---
  /** Stable run identity for a sub-process. Distinct invocations of the same `name` carry distinct
   *  ids, so their phases and log trails never collapse. Falls back to `name` when omitted (the
   *  single-run, back-compat case). */
  subId?: string;
  /** Sub-process display name. */
  name?: string;
  /** Open, consumer-defined grouping label (e.g. a handler/lane). The dashboard groups rows by it. */
  group?: string;

  // --- sub-process state ---
  /** Terminal outcome. Closed enum owned by the lib. */
  status?: 'ok' | 'failed' | 'skipped';
  /** Open, consumer-defined intermediate phase label (a transition; carries no terminal `status`). */
  phase?: string;

  /** @deprecated Owning sub-process **name** for a log line. Superseded by `subId`. Kept so existing
   *  workers/runs render unchanged. New code stamps `subId`. */
  process?: string;

  /** Optional structured payload. `data.durationMs` (number) overrides the derived duration. */
  data?: unknown;
}
```

An event is interpreted by which fields it carries:

| Event kind          | Carries                                  | Lacks            |
|---------------------|------------------------------------------|------------------|
| Phase transition    | `subId`, `name`, `phase`, (`group?`)     | `status`         |
| Terminal outcome    | `subId`, `name`, `status`, (`group?`)    | `phase`          |
| Log line (in a sub) | `subId`, `level`, `message`              | `status`,`phase` |
| Step-level log      | `level`, `message`                       | `subId`, …       |

## API surface (`core` + Python SDK)

The Python sink mirrors the TS `StepContext`/`StepLogger` surface 1:1 (it's a `contextvars` sink), so
the API must be **flat method calls** — no stateful/fluent handles.

Add to `StepLogger` (and the Python `StepContext`/`EventSink` protocol) one unified primitive, with
the existing `sub` kept as back-compat sugar:

```ts
interface StepLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;

  /** Back-compat sugar: a single-run terminal outcome keyed by name. → subEvent({ id: name, name, status }). */
  sub(name: string, status: 'ok' | 'failed' | 'skipped', message?: string, data?: unknown): void;

  /** Unified sub-process event. Pass `phase` for an intermediate transition, `status` for the
   *  terminal outcome. `id` is the run identity; `group` is an open grouping label. */
  subEvent(e: {
    id: string;
    name: string;
    group?: string;
    phase?: string;                          // intermediate
    status?: 'ok' | 'failed' | 'skipped';    // terminal
    message?: string;
    data?: unknown;
  }): void;
}
```

Log tagging follows the run id. The Python sink already has `set_current_process(name)`; it gains a
run-id form (e.g. `set_current_process(id)` stamping `subId`, keeping the `process`-by-name path for
old callers). A log emitted while a sub is "current" is stamped with that `subId`.

> **Naming is open for review** (`subEvent` / `subPhase` / `subUpdate`; `subId` / `runId`). The shape
> is what matters; pick final names during spec review.

## Dashboard rendering (`dashboard`)

`StepDetailPanel.tsx` — `StepEvents` becomes data-driven and grouped by **`subId`** (fallback: `name`
/ `process` for back-compat):

- Build one record per `subId`: `{ id, name, group?, phases: StepEvent[], terminal?: StepEvent,
  logs: StepEvent[] }`.
- **Row** shows: name, duration, terminal status badge (or "running" when no terminal yet). A row is
  an **expandable accordion** when it has phases, logs, or an error; otherwise it stays a flat line
  (today's look for trivial subs).
- **Expanded**: the phase timeline (each phase label + clock + offset from the run/step start),
  duration, terminal badge, error, and the sub's own log lines — all in one panel. This is the parity
  with flip's `ProcessLogs.tsx` per-process expand.
- **Grouping**: when subs carry `group`, render a per-group section (a lightweight "Handler Summary"
  analog) with rows nested under it. No `group` → flat list.
- **Duration**: `terminal.at − firstPhase.at`, or `data.durationMs` when provided.
- **Counts**: `N ok / M failed` aggregate over **distinct `subId`** by terminal `status`. Phase events
  never inflate the count. (This alone removes the apparent "duplication" from collapsed names.)
- **Live**: phase events ride the existing `step.progress` stream that `App.tsx` already merges into
  cached step events — in-flight phases stream in with no transport change.

## Consumer wiring (flip — separate PRs, after lib release)

Two flip changes, sequenced after the lib release. Beyond emitting the lifecycle, flip **restructures
the processing phase** so the durable decomposition matches its natural hierarchy.

### Workflow restructuring: each `handle_*` is its own step

Today, for `type: "all"`, `planPProcesses` returns a single `{ proc: "all" }` body, so the workflow
makes **one** `ctx.call(processingStep, { proc: "all" })` and the Python `run_proc("all")` fans out to
*every* handler (`handle_af_fleet_dependent_processes`, `handle_mel_*`, …) and *every* p-process
inside that **one** step. That's why all 94 subs land in one event list, collapse by name, and the
double-dispatch piles up.

Target: **one durable step per handler** (`handle_*`), each running its own p-processes as
sub-processes. So the `"all"` plan expands to one body per handler group, and the workflow `ctx.call`s
each. Benefits:

- Durable retry/resume per handler — a failure in `mel` resumes at `mel`, not re-running `af_fleet`.
- Handlers never collapse into each other — each is a distinct step in the timeline + graph.
- **A handler that ran twice is two distinct steps** (two seqs), not a merged blob — directly what we
  want ("as vezes que rodaram não podem ficar agrupadas").
- Within a handler-step, its p-processes are subs identified by **run id**, so a proc run more than
  once shows as distinct sub rows, not one row with piled-up logs.

Because the handler boundary is now the **step**, flip does **not** need the lib's `group` field for
the handler dimension — the step is the group. `group` stays in the lib as a generic optional for the
fan-out-within-one-step case; flip uses the step boundary instead.

Open implementation questions (resolve during planning, needs `flip-python-db` reading):
- How `"all"` decomposes into per-handler bodies (enumerate the `*_dep_procs` groups in the dictionary
  vs. a new per-handler plan), and whether handlers have ordering/dependencies that the sequential
  `ctx.call` loop must preserve.
- Whether `run_proc` already supports running a single handler group per call (the v1 typed path sends
  `*_dep_procs` groups individually, so likely yes) or needs a per-handler entry point.

### Emitter

- **`flip-python-db`** — `app/common/durable_proc_events.py` gains an `emit_subphase(id, phase, …)`
  (and a run-id form of `set_current_process`) mirroring `subEvent`. The worker emits flip's lifecycle
  as phases (`"triggered"`, `"validating"`, `"processing"`, …), closes with the terminal outcome, and
  stamps a per-invocation **run id** per p-process. Flip's vocabulary lives in flip.
- **`flip-nestjs`** — the workflow restructuring above (`pipeline.workflow.ts`, `planPProcesses`) plus
  a bump of `@dudousxd/nestjs-durable-*` to the released version (the dashboard is bundled by the lib).

## Out of scope (tracked separately)

- **Double-dispatch root cause.** Some flip handlers *execute* their procs twice (`handle_af_fleet`
  expected 5 / completed 10 = 200%, `mel` 14→28, `metadata` 1→2). Why they fire twice (plan/dispatch,
  or the v1 SQS + v2 durable paths both running, or recovery) is a real upstream flip bug, separate
  from this work. Run identity + handler-as-step make the dashboard **display** the repeats correctly
  (distinct steps / sub rows, not merged); they do not stop the double execution. Separate
  investigation.

## Compatibility & risk

- All new `StepEvent` fields are optional → no store migration, no break for existing runs or
  consumers. Old runs render as they do today (grouped by `name`).
- `sub(name, status)` is preserved verbatim as sugar over `subEvent`.
- `StepEvent.process` is kept (deprecated) so workers that tag logs by name keep grouping.
- Dashboard fallback (key by `name`/`process` when `subId` absent) keeps historical runs readable.
