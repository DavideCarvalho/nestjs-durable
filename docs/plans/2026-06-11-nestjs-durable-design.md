# nestjs-durable — Design

Durable workflows for NestJS (DBOS-style), with steps that can run across apps and
languages. Write a workflow as plain code; the engine checkpoints every step so the
flow survives crashes/deploys and resumes exactly where it stopped. Some steps run
locally in NestJS, others run on a remote worker (Python first) — but it is one
workflow, with one source of truth, and one end-to-end view.

## Why

Today multi-service flows are scattered: a queue here, a queue there, a piece in
Python, and no single place to read or watch the whole flow. `nestjs-durable`
collapses that into:

1. **The flow becomes code, in one place** — read the workflow function, understand the
   whole sequence, even when steps execute in different apps.
2. **Durability** — survives crash/deploy without re-running completed steps.
3. **End-to-end visibility** — because one orchestrator owns the state, it knows about
   *every* step (including the Python ones), so a full-flow trace + dashboard come
   almost for free.

## Goals

- Workflow-as-code DX, NestJS-native (decorators first, functional builder underneath).
- Central orchestrator owns state; remote workers are dumb/stateless.
- Exactly-once *logical* execution of steps via checkpoint + deterministic replay.
- Cross-language steps through a documented wire protocol (Python SDK first).
- Fully decoupled core: knows only *interfaces*, never a concrete transport/store/ORM.
- One package per transport and per store adapter — everything opt-in.
- Observability as a first-class citizen: OpenTelemetry **and** an embedded dashboard.
- First-class testing utilities, including crash injection / replay assertions.

## Two orthogonal abstractions

1. **Transport** — *how* a remote task travels to a worker and the result comes back
   (in-memory, BullMQ, NATS, RabbitMQ…).
2. **StateStore** — *where* workflow runs and step checkpoints live (Postgres-first,
   via ORM adapters).

These are independent: BullMQ + Prisma, or NATS + TypeORM, freely mixed. `core` knows
neither — only the interfaces.

## Architecture

Three distributed pieces:

**1. Engine (orchestrator) — `@dudousxd/nestjs-durable`**
Runs inside the NestJS app. Owns the state. Responsibilities:
- Discover workflows/steps via decorators (`DiscoveryService`).
- Execute the workflow function, intercepting each step call to checkpoint it.
- Dispatch remote steps over the Transport and await the result.
- On boot, scan incomplete runs and **resume** them from the last checkpoint.
- Emit OTel spans and feed the dashboard.

**2. Remote worker SDK — `durable-worker` (Python first, more langs later)**
Dumb/stateless process. Connects to the Transport, registers handlers by name, runs a
task when received, returns the result. Knows nothing about the workflow — only "given
input X for step `charge-card`, run it and return". All durability/retry stays in the
engine.

**3. Store + Transport (pluggable interfaces)**
- `StateStore`: persists workflow runs and step checkpoints (Postgres-first via ORM adapter).
- `Transport`: dispatches a remote task and delivers the result (default = queue).

Request flow:

```
HTTP/event → engine starts a workflow run (row in store)
  → local step:  execute, write checkpoint
  → remote step: enqueue task → Python worker executes → result returns → write checkpoint
  → next step...
  → workflow complete (final status in store)
```

The key property: **the engine never loses the thread.** Even a Python step is, from the
state's point of view, just one more checkpoint in the same place. That is what kills the
"queue here, queue there" sprawl and yields the single view.

## Durable execution model

The DBOS-style mechanism, and the one rule it imposes on the developer.

**The workflow function must be deterministic.** Every source of non-determinism — network
calls, queries, `Date.now()`, random, IO — must live *inside a step*. The workflow body is
pure orchestration: call step, use result, decide next. Why? Recovery works by
**re-executing the workflow function from the top**.

```
workflow run id=abc — each step has a deterministic logical position (seq)
  step[0] charge-card    → execute → store {id:abc, seq:0, output}
  step[1] send-receipt   → execute → store {id:abc, seq:1, output}
  💥 crash
  --- engine restarts, resumes run abc ---
  re-run the function from the top:
  step[0] charge-card    → checkpoint seq:0 EXISTS → do NOT re-run, return saved output
  step[1] send-receipt   → checkpoint seq:1 EXISTS → return saved output
  step[2] ship-order     → no checkpoint → actually execute
```

The dev writes ordinary linear code; the engine guarantees each step runs **exactly once**
logically, even across crashes. Remote (Python) steps follow the same rule — the checkpoint
is written when the worker's result returns.

Consequences:

- **Step idempotency.** The engine guarantees logical exactly-once, but if the process dies
  *after* the worker ran and *before* the checkpoint was written, the step may physically run
  twice. The docs recommend idempotent steps; the engine passes a stable `stepId` so workers
  can dedupe.
- **Retry/backoff** is per-step (`@Step({ retries: 3, backoff: 'exp' })`). Retries exhausted →
  the workflow goes `failed`, with an optional compensation hook (saga).
- **Versioning.** Changing the code of a workflow that has in-flight runs is dangerous (the
  logical positions shift). A `workflowVersion` is stored; old runs resume on the old version
  or are flagged for manual review in the dashboard.

## Authoring API

Decorators on providers as the primary layer, a functional builder underneath for dynamic
cases.

```ts
// Remote step contract: name + in/out schema (zod)
export const chargeCard = remoteStep({
  name: 'payments.charge-card',
  input: z.object({ orderId: z.string(), amountCents: z.number().int() }),
  output: z.object({ chargeId: z.string(), status: z.enum(['ok', 'declined']) }),
  retries: 3,
});

@Workflow()
class CheckoutWorkflow {
  @Step() async reserveStock(ctx: WorkflowCtx, order: Order) { /* runs locally in Nest */ }

  async run(ctx: WorkflowCtx, order: Order) {
    await this.reserveStock(ctx, order);
    const charge = await ctx.call(chargeCard, {        // ↩ dispatched to Python
      orderId: order.id,
      amountCents: order.total,
    });
    await ctx.call(shipOrder, { orderId: order.id });
  }
}
```

`ctx.call(remoteStep, input)` is, to the developer, identical to a local step — same DX,
same checkpoint. Under the hood: validate input against the schema, enqueue
`{ runId, seq, name, input, stepId }` on the transport, await result, validate output,
write checkpoint.

## Remote steps & worker SDK

Worker side (Python):

```python
from durable_worker import Worker

worker = Worker(transport="redis://...", group="payments")

@worker.step("payments.charge-card")
async def charge_card(input: dict) -> dict:
    # input already validated against the schema by the engine
    result = await stripe.charge(input["order_id"], input["amount_cents"])
    return {"charge_id": result.id, "status": "ok"}

worker.run()
```

The worker:
- registers handlers **by name** (the same `name` as the TS stub — the string is the contract).
- consumes from the transport, executes, returns result (or a structured error → engine
  decides retry).
- sends a **heartbeat** during long steps (engine detects a dead worker and re-enqueues).
- uses `stepId` to dedupe if it receives the same task twice.

**Cross-language type-safety.** In v1 the strong contract lives in TS (zod); Python receives a
runtime-validated dict (validated by the engine). Schema-first codegen (protobuf → Python
types) is a fase-2 extension point, deliberately out of v1 scope so it does not block.

**Multiple languages.** Any worker speaking the transport protocol + task format joins. Python
is the first SDK; Go / a Node worker / etc. follow the same contract. The wire protocol is
documented for third parties.

## Pluggable interfaces

Both follow the NestJS module pattern (`forRoot`/`forRootAsync`) with an injectable provider.

```ts
interface Transport {
  dispatch(task: RemoteTask): Promise<void>;                          // engine → worker
  onResult(handler: (result: StepResult) => Promise<void>): void;     // worker → engine
  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void;     // worker liveness
}

interface StateStore {
  createRun(run: WorkflowRun): Promise<void>;
  getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null>;
  saveCheckpoint(cp: StepCheckpoint): Promise<void>;
  listIncompleteRuns(): Promise<WorkflowRun[]>;   // used by recovery on boot
  // ...queries consumed by the dashboard
}
```

- **Transport default: `BullMQTransport`** — already the ecosystem favourite, gives DLQ, retry
  and queue visibility for free. Adapters planned: NATS, RabbitMQ, SQS — each a separate
  package so the core stays lean. `InMemoryTransport` ships for dev/test.
- **StateStore: Postgres-first via ORM adapters** — `store-prisma`, `store-typeorm`,
  `store-drizzle`, `store-mikro-orm`; core couples to none. Each adapter ships migrations
  (`workflow_runs`, `step_checkpoints`, `step_events`). Durable semantics require
  `saveCheckpoint` to be atomic, ideally advancing the run **in the same transaction**.
  Stores without transactions (Mongo/Redis) cannot give the strong guarantee — hence Postgres
  is the blessed path. `InMemoryStore` ships for dev/test.

## Observability

Because the engine sees every step (local and remote), visibility falls out of the source of
truth almost for free.

**Layer 1 — OpenTelemetry (`@dudousxd/nestjs-durable-otel`).**
Each workflow run = one trace; each step = one span (local or remote). The engine injects
`traceparent` into the remote task payload; the Python worker continues the span in its own
app. Result: a single trace crossing NestJS → queue → Python, visible in the Jaeger / Grafana /
Datadog you already run. Span attributes: `workflow.name`, `run.id`, `step.seq`, `step.kind`
(local/remote), `retry.count`, `worker.group`. Errors become span events. No new UI to
maintain for this layer — the *immediate* visibility win.

**Layer 2 — Embedded dashboard (`@dudousxd/nestjs-durable-dashboard`).**
A Nest module mounting a UI that reads **directly from the StateStore** (no OTel collector
dependency). Lean v1 scope:
- **Runs list**: workflow, status (running/completed/failed), duration, timestamp.
- **Run timeline**: each step in order, input/output (with redaction of sensitive fields),
  duration, which app/worker ran it, attempts.
- **Actions**: manual retry of a `failed` run, cancel a `running` one.
- Mounted as a Nest route (`/durable`) with a pluggable auth guard.

The timeline is the "see the whole flow" goal: a checkout shows as one ruler —
`reserveStock (nest) → chargeCard (python) → shipOrder (nest)` — without opening four repos.

The two complement rather than compete: OTel is for **debugging production** (latency,
correlation, alerts in your stack); the dashboard is for **operating the workflow** (business
state, re-running failures) without an observability stack stood up.

Out of v1 scope (noted to avoid bloat): editing workflows from the UI, aggregate
metrics/charts, multi-tenant dashboard, schema-first cross-language codegen.

## Monorepo layout

Same stack as `nestjs-notifications`: pnpm workspaces + Turborepo + Vitest + Biome +
Changesets, scope `@dudousxd/…`, `type: commonjs` + `tsc` build, peerDeps for Nest/ORM and
exact devDeps, 0.x versions (peerDep major cascade — stay in 0.x).

```
packages/
  core/              @dudousxd/nestjs-durable-core       interfaces, engine, replay, decorators, builder, DI tokens
  nestjs/            @dudousxd/nestjs-durable             Nest module, DiscoveryService, WorkflowCtx, boot recovery
  transport/         @dudousxd/nestjs-durable-transport   Transport interface + InMemoryTransport
  transport-bullmq/  default queue adapter (reuses the app's @nestjs/bullmq)
  transport-nats/    transport-rabbitmq/                  opt-in adapters
  store/             @dudousxd/nestjs-durable-store       StateStore interface + InMemoryStore + base migrations
  store-prisma/      store-typeorm/  store-drizzle/  store-mikro-orm/   ORM adapters
  otel/              @dudousxd/nestjs-durable-otel        OpenTelemetry instrumentation (spans, traceparent)
  dashboard/         @dudousxd/nestjs-durable-dashboard   Nest module with UI + StateStore queries
  testing/           @dudousxd/nestjs-durable-testing     WorkflowFake, time-travel, assertions, in-memory everything
clients/
  python/            durable-worker (PyPI)                remote worker SDK
examples/
  basic/             Nest app + Python worker (checkout: reserveStock → chargeCard(py) → shipOrder)
docs/  website/  scripts/  turbo.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json
```

## Testing

`@dudousxd/nestjs-durable-testing`, in the spirit of `NotificationFake`:
- `InMemoryStore` + `InMemoryTransport` to run a whole workflow in a test, no Postgres/Redis.
- **Time-travel / crash injection**: simulate a crash mid-run and assert replay resumes
  correctly (completed steps NOT re-run; pending steps executed) — the test that earns
  confidence in durability.
- Assertions: `assertWorkflowCompleted`, `assertStepRanOnce('payments.charge-card')`,
  `assertStepDispatchedTo('payments')`, `assertRetried(n)`.
- Worker fake to test remote steps without standing up Python.

## Open questions / fase 2

- Schema-first codegen (protobuf/JSON Schema) for strong cross-language types.
- Sub-workflows / child workflows and fan-out (parallel steps with a join).
- Signals / external events (wait for a human approval, a webhook).
- Durable timers / sleep (`ctx.sleep('1d')`) surviving restarts.
- Additional worker SDKs (Go, Node-worker).
