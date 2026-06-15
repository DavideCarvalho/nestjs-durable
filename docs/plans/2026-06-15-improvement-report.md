# nestjs-durable — improvement report (2026-06-15)

A fresh competitive analysis after this cycle's additions (dispatch model, self-healing
recovery, events/onEvent, search attributes, interceptors, input validation, singleton,
metrics, codec store). The library is now broad — this focuses on the **genuine remaining gaps**
and where existing features can go further.

## TL;DR

We've closed most of the basics. In raw durability primitives we now **exceed** Vercel WDK,
Cloudflare Workflows, and Inngest, and **approach** Temporal/DBOS/Restate in breadth. The
remaining gaps are advanced/semantic, and three stand out as high-value:

1. **Exactly-once transactional steps** (DBOS's signature) — the one real *correctness* gap.
2. **Signal-with-start** — small effort, unlocks the durable-entity/accumulator pattern.
3. **Cancellation propagation to children** — a correctness hole in our child-workflow story.

## What we have today

- **Authoring (`ctx`)**: `step`, `call` (remote), `sleep`, `sleepUntil`, `continueAsNew`,
  `waitForSignal`, `waitForEvent`, `task` (async external), `child`, `startChild`, `breakpoint`,
  `webhook`, `setEvent` (query state), `onUpdate` (validated), `patched` (versioning), deterministic
  `now`/`random`/`uuid`.
- **Engine**: deterministic replay, **dispatch model** (start enqueues → worker runs; `pending`
  status, `RunDispatcher`, `runOne`/`runPending`/`waitForRun`), **self-healing recovery** (lease
  renewal + periodic, non-blocking re-enqueue), DLQ (`maxRecoveryAttempts` + `dead` + `@DeadLetter`),
  schedules (cron + tz + pause + overlap:skip), **flow-control queues** (concurrency + rate),
  **singleton** (durable FIFO mutex per key), `executionTimeout`, **events** (publish + `onEvent`
  triggers), **typed search attributes** (range queries), **interceptors**, **input validation**
  (class-validator), Prometheus metrics, saga compensation (+ retry), cooperative cancellation,
  multi-transport failover + control plane.
- **Stores**: typeorm / prisma / mikro-orm / drizzle / in-memory; `CodecStateStore`
  (encrypt/compress/redact at rest).
- **Transports**: bullmq / sqs / db / event-emitter.
- **Surfaces**: React-Flow dashboard (retry/cancel/continue, tags + attribute filters, SSE
  live-tail, DLQ view, bulk actions, metrics), OTel, Telescope, non-determinism lint, codegen,
  Python remote-step SDK, dev CLI.

## Comparison vs alternatives

| Capability | us | Temporal | DBOS | Vercel WDK | Inngest | Restate |
|---|---|---|---|---|---|---|
| Durable steps + replay | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Signals / queries / updates | ✅ | ✅ | ~ | ~ | ~ | ✅ |
| Child workflows (await result) | ✅ | ✅ | ✅ | ✅ (invoke) | ✅ (invoke) | ✅ |
| Timers / sleep / sleepUntil | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| continueAsNew | ✅ | ✅ | — | — | — | ~ |
| Versioning / patch | ✅ | ✅ | ~ | — | — | ~ |
| Saga / compensation | ✅ | ✅ | — | — | — | ✅ |
| Schedules (cron) | ✅ | ✅ | ✅ | ~ | ✅ | ✅ |
| Flow-control (concurrency/rate) | ✅ | ~ | ✅ (queues) | — | ✅ | ~ |
| Event triggers | ✅ | ~ | — | ✅ | ✅ | ✅ |
| Search attributes (typed/range) | ✅ | ✅ | ~ | — | — | — |
| Dashboard / observability | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Exactly-once transactional step** | ❌ | ~ | ✅ | — | — | ✅ |
| **Signal-with-start** | ❌ | ✅ | — | — | — | ~ |
| **Cancel → child propagation** | ❌ | ✅ | — | — | ✅ | ✅ |
| **Durable keyed entities/state** | ~ (singleton) | ~ | — | — | — | ✅ |
| **Event batching / debounce** | ❌ | — | — | — | ✅ | — |
| **Priority queues** | ❌ | ~ | ✅ | — | ✅ | — |
| `ctx.condition(predicate)` | ❌ | ✅ | — | — | — | — |
| Multi-tenant namespaces | ~ (tags) | ✅ | ~ | — | ~ | ✅ |

`~` = partial / different shape. We're ahead of Vercel/Cloudflare/Inngest on primitive breadth;
behind DBOS on transactional exactly-once and Restate on stateful entities; behind Temporal/Inngest
on a few advanced controls.

## Gaps — prioritized

### P0 — high value, fills a real gap

**1. Exactly-once transactional steps (`ctx.transaction`)** — *the* correctness gap.
Today a `ctx.step` is **at-least-once**: we run the body, then checkpoint. A crash between the
side-effect and the checkpoint re-runs the step on recovery. DBOS solves this by making the step a
**DB transaction that also writes the checkpoint** — atomic, so the business write and the "done"
marker commit together. We can offer this for the SQL stores: `ctx.transaction(name, (tx) => ...)`
runs the user's DB work and the checkpoint insert in **one** transaction on the durable store's
connection. Exactly-once for DB-backed work; documented as "same-DB only." Biggest semantic upgrade.

**2. Signal-with-start (`engine.signalWithStart` / `workflowService`)** — small, high-leverage.
Atomic "resume the run if it exists, else start it then deliver the signal." This is the canonical
**durable-entity / accumulator** pattern (a per-customer cart, a debounced aggregator). We already
have idempotent `start` + `signal`; combining them race-free is a thin addition and a big ergonomics
win.

**3. Cancellation propagation to children.** `engine.cancel(parent)` does **not** cancel the runs it
started via `ctx.child`/`startChild`. We already track parent→child for result delivery
(`notifyParent`); add the reverse edge (record child ids on the parent) and cascade cancel. Without
it, cancelling a pipeline orphans its sub-runs. Correctness, not nicety.

### P1 — valuable, scoped

**4. Event batching + debounce for `onEvent`.** Inngest's edge: coalesce a burst of events into one
run (`batch: { maxSize, within }`) or debounce (`debounce: '30s'`, restart the timer on each event).
Natural fit for our event triggers; needs a small "pending trigger" buffer keyed by event+key.

**5. Priority + fairness in flow-control queues.** Queues are FIFO concurrency/rate today. Add an
optional `priority` (per `ctx.call`) and per-key fairness so one noisy key can't starve others.

**6. Durable keyed entities (Restate-style virtual objects).** A `@Entity` whose handlers are
**serialized per key** and share **durable per-key state** — an actor with exactly-once handlers.
Singleton already gives us per-key serialization; entities add the durable state + a handler API.
Bigger feature, but it generalizes singleton and unlocks stateful patterns (counters, carts, rate
limiters) without a workflow-per-entity.

**7. Workflow-level retry policy.** Step retries + DLQ exist, but there's no "retry the *whole*
workflow N times with backoff before dead-lettering." A `@Workflow({ retry: { attempts, backoff } })`
re-runs a failed run (fresh history) before it goes to `dead`.

### P2 — niche / parity

- **`ctx.condition(predicate)`** — still an awkward fit for the suspend model (deliberately skipped;
  see memory). A scoped `ctx.condition(pred, { signal })` (re-check on each signal) is the only sane
  shape; low priority.
- **Multi-tenant namespaces** — tags cover search; true isolation (separate dispatch/quotas per
  tenant) is a larger concern. Defer unless a tenant needs it.
- **Schedule backfill + jitter** — run missed windows on catch-up; jitter to avoid thundering herds.
- **Cancel-by-event** (Inngest) — cancel runs matching an event/filter. We have bulk-cancel by
  filter already; an event-driven trigger for it is a thin wrapper.

## Improvements to existing features

- **Low-latency cross-pod dispatch.** The DB-only path waits up to one poll tick (~1s) for a worker
  to `runPending` a freshly-enqueued run. A control-plane `run.enqueued` nudge (we already have the
  control plane) makes it near-instant — worth it now that dispatch is the default.
- **Long *local* steps are a foot-gun** (the file-export that hung worker boot). Lease renewal fixed
  the *recovery* side, but a long synchronous `ctx.step` still blocks the worker's event loop. Offer
  **progress checkpointing inside a step** (`ctx.step(name, (set) => ... set(progress))`) and/or
  guidance to push heavy work to `ctx.call` (a remote step) — and surface step progress in the
  dashboard.
- **Metrics depth.** Add per-step latency histograms, **queue-depth** gauges, **DLQ size**, and a
  **pending-runs (dispatch backlog)** gauge — the backlog gauge is the key health signal of the new
  dispatch model.
- **DLQ ergonomics.** Retry-from-`dead` with an **edited input** (a "fix and replay" from the
  dashboard); a DLQ-size alarm.
- **Dashboard.** Search by input/output **content**; a parent→children **run tree** view; replay
  with edited input.
- **Recovery tunables.** Now that recovery re-enqueues, expose a batch size + a per-run recovery
  backoff so a flood of orphans drains smoothly.
- **Singleton back-pressure.** A `maxQueueDepth` so an unbounded backlog of same-key runs can be
  rejected/dead-lettered instead of growing forever.

## Recommended order

1. **Signal-with-start** (small, unlocks the entity pattern) →
2. **Cancel→child propagation** (correctness) →
3. **Low-latency dispatch nudge + dispatch-backlog metric** (round out the new dispatch model) →
4. **Exactly-once `ctx.transaction`** (headline DBOS-parity feature; SQL stores) →
5. **Event batching/debounce** + **queue priority** (Inngest-parity flow control) →
6. **Durable entities** (the big one; generalizes singleton) →
7. Polish: DLQ edit-and-replay, dashboard run-tree, metrics depth.

Items 1–3 are days; 4 and 6 are the substantial ones.
