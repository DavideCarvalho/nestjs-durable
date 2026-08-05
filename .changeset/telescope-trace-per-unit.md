---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/durable-worker': minor
'@dudousxd/nestjs-durable-telescope': minor
---

Give every workflow turn and every step handler a Telescope batch, so what durable work *does* is
correlated to the work that did it.

`@dudousxd/nestjs-durable-telescope` opened no batch at all. It subscribed to engine events and
recorded an entry per event, which tells you that `step.failed` happened — and nothing about what the
step was doing when it failed. The queries it issued, the outbound calls it made and the exception it
threw were recorded by Telescope's other watchers with no batch and no trace context active, so they
landed traceless: unfindable from the run, and invisible in the trace waterfall. Recording an event
after the fact cannot fix that, because by then the body has returned.

**The seam.** Wrapping execution needed a hook, and the engine's existing one is the wrong shape:
`engine.use` (`StepInterceptor`) fires only around the in-process `localStep` primitives —
`ctx.now`, `ctx.sideEffect`, `ctx.task`'s dispatch step, saga compensations — because a user's
`ctx.step` is *always dispatched*, so its handler runs inside a transport callback or a worker
process where no engine is in scope at all. So core gains a process-level registry,
`useDurableExecution(wrapper)`, folded in at the three places a unit of durable work actually
executes:

- `WorkflowEngine.runExecution` — one whole TS workflow turn, including the store writes that bracket
  the body, because those are precisely the queries you want attributed to the turn that issued them;
- `runStepHandler` in core's `protocol.ts` — the one function every transport (BullMQ, SQS,
  event-emitter, DB, in-memory) funnels a step handler through;
- `StepWorker.processTask` / `WorkflowWorker.processTask` in `@dudousxd/durable-worker` — the same
  two units on the thin/co-located worker path, which has no engine to hang a hook off. That is why
  the registry is process-level rather than per-engine.

Nothing is registered by default: with an empty registry `runDurableExecution` returns the body's own
promise without allocating a chain, so a host that wires no observability pays nothing. A wrapper's
return value and its throws are deliberately discarded — the body's outcome is the only thing that
can settle the call, so a misbehaving observer can never turn a failed step into a completed one and
corrupt a run's history.

**The trace.** The watcher previously held a live root span per run and ended it on `run.suspended`,
which fragments a durable workflow into one trace per turn — the failing step in a different trace
from the turn that dispatched it. The trace id is now **derived from the run id**, so a run is one
trace no matter how many times it suspends, how long it waits, or how many processes execute it — a
worker elsewhere derives the same id from the same id. Lifecycle entries state that trace id
explicitly, so an event emitted outside any execution scope (a remote step's result landing in a
transport callback, a recovery sweep) is still findable from the run.

**Nesting.** A unit reuses the open batch when *this* Telescope wiring already has one for *this* run
on the current async path; anything else opens a fresh one. The consequence differs by transport and
is worth knowing before you meet it: with an in-process transport the step handler runs inside the
turn that dispatched it and its result resumes the next turn on the same path, so the whole run is
one batch — it genuinely is one causal chain; with a queue-backed transport each turn and each step
is a separate entry point in a separate process and gets its own. A child workflow is a different
run, so it always gets its own batch and its own trace. The `traceId` is the invariant that holds
across every shape.

**Origin.** Batches are recorded as `origin: 'queue'`. Telescope's `BatchOrigin` is the closed union
`'http' | 'queue' | 'schedule' | 'cli' | 'manual'` with no durable/workflow member; widening it
belongs to that repo and a coordinated release, and `'queue'` is accurate anyway — durable work
reaches an executor by being dispatched over a transport, exactly like the jobs the BullMQ watcher
marks `'queue'`.

**New: `durableTraceContext()`.** Telescope resolves an entry's trace id from an ambient OTel span,
and `@opentelemetry/api` alone propagates nothing — without a registered context manager
`context.with(...)` is a no-op. An app running no OTel SDK (most of them) would therefore get
correlated batches and null trace ids. Pass `TelescopeModule.forRoot({ traceContext:
durableTraceContext() })` and entries recorded by the *other* watchers during a turn or step pick up
the run's trace too. An app that does run a full OTel SDK keeps `OtelTraceContextProvider` —
optionally as `durableTraceContext(new OtelTraceContextProvider())`, which consults it first — and
both agree, because the scope's spans already hang off the run's trace.

**Not covered, deliberately.** A remote step (a Python handler, say) executes out of process; its
lifecycle entries carry the run's trace id, but the queries and exceptions inside it are that
runtime's to record. A remote workflow is likewise unwrapped: the engine dispatches a workflow task
and awaits a decision rather than executing a body, and a scope around a dispatch would describe the
wrong thing.
