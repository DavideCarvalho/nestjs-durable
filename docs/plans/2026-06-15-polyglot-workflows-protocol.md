# Polyglot workflows — the workflow-task / commands protocol

Status: **draft / spec** (no code yet). This is the contract the rest of the work hangs on.

## Goal

Let a **workflow** (not just a step) be authored and run in a non-TS SDK — first Python. A Python
service should be able to write `@workflow def pipeline(ctx, input): ...` using `ctx.step` / `ctx.call`
/ `ctx.sleep` / `ctx.wait_signal`, with the same durability guarantees as a TS workflow.

## Non-goals / the load-bearing constraint

- **One owner of the durable DB.** The `durable_*` tables stay owned and written **only** by the
  engine (today: nestjs). A Python runtime must NOT open a MySQL connection to the checkpoint tables.
  (Both because the project rule is "nestjs owns schema, python only queries", and because two engines
  writing one checkpoint format = two replay implementations that must stay bit-identical forever.)
- **One source of truth for recovery / timers / singleton / dead-letter.** These stay in the engine.
  A workflow worker has none of them — it only replays a function and emits decisions.

So this is the **coordinator-driven** (Temporal-style) model, NOT a second engine:

```
engine (coordinator — owns durable_* + recovery + timers)
   │  WorkflowTask { workflow, input, history[] }     ── over the existing transport ──┐
   ▼                                                                                   │
workflow worker (Python)  ── replays the function LOCALLY against history ──┐          │
   │  WorkflowDecision { commands[] | completed | failed }                  │          │
   ▼                                                                        │          │
engine applies: persist checkpoints, dispatch steps, schedule timers ◄──────┘──────────┘
```

The **replay runs in the worker** (the function is Python); **only the engine touches the DB**.

The **control plane (Redis pub/sub)** is unchanged and already shared — the Python worker already
publishes `step.progress` and observes cancellation on `durable-control`. Live events / cancellation
keep going Python ↔ Redis directly. Only *durable state* goes through the engine via this protocol.

## Turn lifecycle

A run whose workflow is registered as **remote** (a Python workflow) is advanced one *workflow task*
at a time. A turn:

1. The engine has a run that needs to advance (just started, or a step result / timer / signal just
   landed). It loads the run's completed checkpoints = the **history**.
2. The engine dispatches a `WorkflowTask` { workflow, version, input, history } to the workflow
   worker group over the transport.
3. The worker replays the workflow function from the top. Each `ctx.*` op is keyed by a deterministic
   `seq`. For each op:
   - **in history** → return the recorded result (replay; no command).
   - **not in history** → it's a new decision → emit the matching command. The function blocks at the
     first *unresolved await* (a step/sleep/signal with no result yet); parallel awaits emit all their
     commands before blocking.
4. The worker returns a `WorkflowDecision`: the `commands[]` produced this turn, plus a status —
   `continue` (still blocked on awaits), `completed` (output), or `failed` (error).
5. The engine applies the decision **atomically**: persist any recorded local-step checkpoints, persist
   the new pending remote-step/timer/signal checkpoints, dispatch the remote steps, schedule the timers,
   or settle the run (completed/failed). It never re-runs anything already in history.
6. When an awaited thing resolves (a `StepResult` arrives, a timer fires, a signal is delivered), the
   engine appends it to history and loops to step 1 — a fresh task with the extended history. The
   worker replays again, the await now resolves from history, and the function produces its next
   decision. Repeat until `completed`/`failed`.

This is exactly how the engine already drives TS workflows (replay from checkpoints) — except the
replay is a network hop into the worker instead of an in-process call.

## Wire types

Mirrors the existing `RemoteTask` / `StepResult` style. Canonical TS; the Python SDK mirrors the JSON.

```ts
/** engine → workflow worker: advance this run one turn by replaying against `history`. */
export interface WorkflowTask {
  /** Dedupe id for this turn (a re-delivered task must be idempotent). */
  taskId: string;
  runId: string;
  /** Registered workflow name + the version the run started on (replay must use that version). */
  workflow: string;
  workflowVersion: string;
  input: unknown;
  /** Completed durable ops so far, ordered by seq — what the worker replays results from. */
  history: HistoryEvent[];
  /** Signals delivered but not yet consumed (so `ctx.wait_signal` resolves on replay). */
  pendingSignals?: Array<{ seq: number; signal: string; payload: unknown }>;
  group: string;
  transport?: string;
  traceparent?: string;
  attempt: number;
}

/** One resolved durable op in the run's history. A superset of a completed StepCheckpoint. */
export interface HistoryEvent {
  seq: number;
  kind: 'step' | 'call' | 'timer' | 'signal' | 'child';
  name?: string;
  /** Resolved value: a step/call output, a child run's output, a signal payload. */
  output?: unknown;
  /** Set when the op resolved to a failure (a failed remote step the workflow may catch). */
  error?: StepError;
}

/** workflow worker → engine: the result of replaying one turn. */
export interface WorkflowDecision {
  taskId: string;
  runId: string;
  status: 'continue' | 'completed' | 'failed';
  /** New durable ops the replay produced this turn (status === 'continue'). Ordered by seq. */
  commands: Command[];
  /** Final workflow output (status === 'completed'). */
  output?: unknown;
  /** Terminal error (status === 'failed'). */
  error?: StepError;
}

/** A decision the workflow function made at a `seq` not yet in history. */
export type Command =
  /** ctx.call(remoteStep, input) — dispatch a remote step and await it. */
  | { kind: 'call'; seq: number; name: string; group: string; input: unknown }
  /** ctx.step(name, body) — a local step the worker ALREADY RAN this turn; persist its result so
   *  replay returns it instead of re-running (durability for side-effectful/non-deterministic work). */
  | { kind: 'recordStep'; seq: number; name: string; output?: unknown; error?: StepError }
  /** ctx.sleep(ms) — durable timer; the engine resumes the run at `untilMs`. */
  | { kind: 'sleep'; seq: number; untilMs: number }
  /** ctx.wait_signal(name) — block until a signal `name` is delivered to the run. */
  | { kind: 'waitSignal'; seq: number; signal: string }
  /** ctx.start_child(workflow, input) — start a child run (its own lifecycle). */
  | { kind: 'startChild'; seq: number; workflow: string; input: unknown };
```

## Determinism & replay rules

- **seq is the join key.** The worker assigns each `ctx.*` op a deterministic seq (the order the
  function reaches them on replay). A history event with that seq IS that op's result. Same code +
  same history ⇒ same seqs ⇒ deterministic.
- **Local steps run on the worker, are persisted by the engine.** A `ctx.step(name, body)` not in
  history: the worker runs `body()` during replay, then emits `recordStep` with the result. The
  engine persists it; next turn it's in history and the worker returns the recorded value WITHOUT
  re-running. This is what makes `ctx.step` the place to put side effects / non-determinism
  (`now()`, `uuid()`, a DB write) — captured once, replayed forever. A turn may carry several
  `recordStep`s (the function ran several local steps) followed by the blocking command(s).
- **Blocking ops suspend the turn.** `call` / `sleep` / `waitSignal` / `startChild` not in history
  emit their command and the function cannot proceed past the await — the worker returns `continue`
  with the commands gathered up to that barrier. Parallel awaits (`asyncio.gather`) emit all their
  commands in one turn.
- **Non-determinism detection.** If a history event's (seq, kind, name) doesn't match what the
  replay produces at that seq, the worker raises a non-determinism error → the run fails loudly
  (mirrors the TS engine's replay guard). Workflow code changes are handled by `workflowVersion`
  pinning (the run replays on the version it started on), same as TS.

## Engine integration (TS side)

Add a **pluggable workflow executor** to the engine. Today execution is implicitly in-process. Make
it an interface:

```ts
interface WorkflowExecutor {
  /** Advance `run` one turn given its history; return the decision to apply. */
  advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision>;
}
```

- **InProcessExecutor** (existing behaviour, default): runs the registered TS function with the
  current replay machinery, adapted to return a `WorkflowDecision` instead of mutating directly.
- **RemoteWorkflowExecutor** (new): dispatches a `WorkflowTask` over the transport to the workflow
  worker group and awaits the `WorkflowDecision`. Used when a workflow name is registered as remote
  (e.g. `engine.registerRemote('pipeline', { group: 'py-workflows' })`).

The engine's apply-decision step (persist checkpoints, dispatch commands, settle run) is **shared**
by both executors — recovery, timers, singleton, dead-letter all stay engine-owned and untouched.

## Recovery, cancellation, signals

- **Recovery** is unchanged: a crashed run is re-advanced from its persisted history — for a remote
  workflow that just means re-dispatching a `WorkflowTask` with the full history. The worker is
  stateless across turns (it replays from history every turn), so nothing to recover worker-side.
- **Cancellation** rides the existing control plane: the engine publishes `cancel` on `durable-control`;
  the Python worker already observes it (`ctx.cancelled`) and the in-flight turn bails.
- **Signals / child workflows** are engine concerns (delivery, child lifecycle); the worker only sees
  them resolved in `history` / `pendingSignals` and via the `waitSignal` / `startChild` commands.

## Transport & routing

Reuse the BullMQ transport. A `WorkflowTask` is a second task type on a dedicated group (e.g.
`py-workflows`), separate from step groups, so a workflow worker and a step worker don't cross-consume.
Queue naming follows the existing `<prefix>-tasks-<group>` / `<prefix>-results` convention; the
decision comes back like a `StepResult` does today.

## Phasing

1. **Protocol types** (this doc) → land the TS interfaces (`WorkflowTask`, `HistoryEvent`, `Command`,
   `WorkflowDecision`) + the `WorkflowExecutor` interface, no behaviour change.
2. **InProcessExecutor refactor**: make the existing TS engine route through `WorkflowExecutor.advance`
   returning a decision — pure refactor, fully covered by existing tests. De-risks everything.
3. **RemoteWorkflowExecutor** + transport workflow-task channel + `engine.registerRemote`.
4. **Python `@workflow` + replay runtime** in `durable-worker`: `WorkflowContext` whose `ctx.step`/
   `call`/`sleep`/`wait_signal` produce commands / read history; a `WorkflowWorker` that consumes
   workflow tasks and returns decisions. No store, no recovery — just replay.
5. **Interop validation**: a TS workflow calling a Python step, a Python workflow calling a TS/Python
   step, both visible in the dashboard; recovery mid-run; cancellation.

## Open questions

- **Local-step round-trips.** Each turn persists its `recordStep`s; a workflow that does N local steps
  back-to-back with no blocking await still resolves them in ONE turn (the worker runs them all before
  the first barrier), so it's not N round-trips — but a workflow that interleaves local steps with
  awaits pays a turn per barrier. Acceptable (same as Temporal); revisit if a hot path needs batching.
- **History size.** Sending full history each turn is simple but grows with run length. Fine for the
  pipeline-shaped runs we have (a handful of steps). If a run gets very long, switch to incremental
  history (send only events since the last task) with the worker caching replay state — a later
  optimization, not v1.
- **Determinism libraries.** Python replay must forbid wall-clock/random/IO outside `ctx.step` (like
  the TS eslint rule). Start with docs + a runtime guard on the obvious ones (`time`, `random`).
```
