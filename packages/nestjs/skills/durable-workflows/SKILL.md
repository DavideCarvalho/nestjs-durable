---
name: durable-workflows
description: >
  Author durable workflows with @dudousxd/nestjs-durable — @Workflow({ name, version }) classes with a
  run(ctx, input) body and ONE durable step primitive: ctx.step(handlerRef | name, input, opts?),
  always dispatched, always engine-scheduled. @Step()-decorated provider methods carry the routing
  identity (derived Class.method name, or an explicit override); a method reference dispatches a
  same-process/typed step, a string name dispatches a cross-runtime one (e.g. a Python worker). Covers
  retries/backoff and FatalError, Promise.all fan-out, sub-process log.sub/subProcess annotations
  inside a @Step handler, ctx.child for cross-runtime sub-workflows, and constructor dependency
  injection inside a workflow class.
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-durable"
  library_version: 0.22.0
  framework: nestjs
---

# Authoring durable workflows

A workflow is a provider decorated with `@Workflow`; its `run(ctx, input)` method is the
deterministic body the engine executes and replays. Work happens in **steps** — always dispatched,
always durably checkpointed. There is no local/remote placement choice: `ctx.step` is the ONE step
primitive, and the worker that ends up serving it (this process, another pool, another language) is
an infrastructure decision, not something the workflow body encodes.

## Setup

```ts title="checkout.workflow.ts"
import { Workflow } from '@dudousxd/nestjs-durable';
import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { PaymentsWorker } from './payments.worker';

// 1. The workflow — plain linear code; ctx primitives are the only durable surface.
@Workflow({ name: 'checkout', version: '1' })
export class CheckoutWorkflow {
  constructor(private readonly payments: PaymentsWorker) {} // normal DI

  async run(ctx: WorkflowCtx, order: { id: string; total: number }) {
    // Dispatch by METHOD REFERENCE: the routing name comes off the @Step-stamped method, typed by
    // its own signature — refactor-safe, autocompleted.
    await ctx.step(this.payments.reserveStock, order);

    const charge = await ctx.step(this.payments.charge, {
      orderId: order.id,
      amountCents: order.total,
    });

    return { chargeId: charge.chargeId };
  }
}
```

```ts title="payments.worker.ts"
import { Step } from '@dudousxd/nestjs-durable';
import { Injectable } from '@nestjs/common';

// 2. The step handlers this workflow dispatches to — each method is one durable checkpoint. All of
// them happen to run in THIS process here (via the event-emitter transport), but nothing about the
// workflow code above would change if `charge` moved to a separate Python/Node worker over BullMQ —
// ctx.step dispatches by name either way.
@Injectable()
export class PaymentsWorker {
  @Step()                                          // name = "PaymentsWorker.reserveStock" (derived)
  async reserveStock(_order: { id: string; total: number }): Promise<{ reserved: boolean }> {
    // reserve inventory for order.id
    return { reserved: true };
  }

  @Step('payments.charge-card')                    // explicit name override
  async charge(input: { orderId: string; amountCents: number }): Promise<{ chargeId: string }> {
    // await stripe.charge(...)
    return { chargeId: `ch_${input.orderId}` };
  }
}
```

Register all providers (see the durable-setup skill).

## Core patterns

### Two call forms — reference and string

```ts
// JS handler in this codebase → pass the method reference. Name + input/output types come from the
// @Step-decorated method — no separate def to declare or keep in sync.
const r = await ctx.step(this.extraction.runExtractionPage, { page, key });

// Cross-runtime handler (e.g. a Python @step) → there's no JS reference to import, so name it by
// string. Both forms dispatch identically over the wire.
const out = await ctx.step<ProcResult>('processing:proc', input);
```

`@Step()` (bare) derives the routing name from the method as `` `${ClassName}.${method}` ``;
`@Step('custom:name')` overrides it explicitly — needed for a cross-runtime contract where the other
side has no `@Step` of its own. `@Step({ name?, input?, output?, retries?, backoff?, backoffMs?,
backoffMaxMs?, jitter?, timeoutMs? })` additionally opts into RUNTIME zod validation (`input`
validates before the method runs, `output` validates its return value) and a def-level durable-retry
policy — a bare `@Step()` skips both and dispatches with no retry/timeout.

Every dispatched step is a first-class checkpoint: on crash/replay a `completed` one returns its
saved result instead of re-executing.

### Retries, backoff, and FatalError

Retry policy can live on the `@Step` decorator (the default for every call to that handler) or be
overridden per call site via `ctx.step`'s `opts` — a call-site value wins field-by-field.

```ts
@Step({ retries: 5, backoff: 'exp', backoffMs: 200, jitter: true })
async charge(order: Order) {
  const res = await this.stripe.charge(order);
  if (res.declined) throw new FatalError('card declined', 'declined'); // fails the run now, no retry
  return res;
}
```

```ts
// Per-call override — wins over the @Step-declared policy for THIS dispatch only.
await ctx.step(this.payments.charge, order, { retries: 1 });
```

`StepDispatchOpts` (the `ctx.step` third argument): `queue`, `priority`, `fairnessKey`, `transport`,
`retries`, `backoff` (`'fixed'` | `'exp'`), `backoffMs`, `backoffMaxMs`, `jitter`, `timeoutMs` (a
liveness window — no result/heartbeat within it presumes the worker dead and re-dispatches).

### Fan-out

Dispatch steps concurrently with `Promise.all` — each `ctx.step` call takes its position in the
synchronous prefix before suspending, so replay stays deterministic:

```ts
const [a, b] = await Promise.all([
  ctx.step(this.svc.stepA, input),
  ctx.step(this.svc.stepB, input),
]);
```

### Sub-process events inside a step

For pure visibility *inside* one step's execution, the `@Step` handler's optional second argument
(`log: StepLogger`) records annotations — they ride back with the step's result and are NOT separate
checkpoints, so they re-run if the step retries:

```ts
import type { StepLogger } from '@dudousxd/nestjs-durable-core';

@Step()
async processBatch(batch: Item[], log: StepLogger) {
  for (const item of batch) {
    await handle(item);
    log.sub(item.id, 'ok'); // shown under the step; not a checkpoint of its own
  }
}
```

### Cross-runtime sub-workflows: ctx.child

`ctx.step` dispatches ONE step handler; to hand off a whole **workflow** — including to another
language's runtime (e.g. a Python worker) — use `ctx.child` instead. Pass the child's class for a
typed, same-runtime child, or a string name for a cross-runtime one:

```ts
// Same-runtime, typed:
const result = await ctx.child(ShippingWorkflow, { orderId: order.id });

// Cross-runtime (e.g. a Python-registered workflow) — no class to import, so by name:
const rows = await ctx.child<{ rows: number }>('processing', { baseId });
```

`ctx.child` starts the child once (checkpointed) and suspends — zero compute — until it reaches a
terminal state, then resumes with its output (or throws if the child failed). Use `ctx.all(Class,
inputs)` / `ctx.all(name, inputs)` to fan out N children of the same workflow and wait for all of
them.

## Common mistakes

### 1. Doing durable work directly in the body instead of in a step

```ts
// ✗ Wrong — the write re-runs on every replay (not checkpointed)
async run(ctx, order) {
  await this.db.insert(order);        // re-executed each recovery → duplicate rows
  return { ok: true };
}

// ✓ Correct — move it into a @Step handler so it checkpoints and runs exactly once logically
async run(ctx, order) {
  await ctx.step(this.orders.persist, order);
  return { ok: true };
}
```

Only `ctx.step`/`ctx.transaction` results are checkpointed; raw work in the body re-runs on replay.
Source: website/content/docs/concepts/durability.mdx.

### 2. A method reference with no @Step stamp

```ts
// ✗ Wrong — plain method, no @Step decorator → ctx.step has no routing name to read
class PaymentsWorker {
  async charge(input: ChargeInput) { /* ... */ }
}
await ctx.step(this.payments.charge, input); // throws — "handler is not a @Step reference"

// ✓ Correct — decorate the handler so its name is stamped for ctx.step to read
class PaymentsWorker {
  @Step()
  async charge(input: ChargeInput) { /* ... */ }
}
```

`ctx.step` reads the routing name off a shared symbol `@Step` stamps on the method — the reference
itself is never invoked directly (the serving worker re-resolves the real handler from DI), so an
undecorated method has nothing for `ctx.step` to route on. Source: packages/nestjs/src/decorators.ts
(`Step`), packages/core/src/workflow-ctx.ts (`step`).

### 3. Throwing a plain Error when you meant to stop retrying

```ts
// ✗ Wrong — a plain Error is retried up to `retries`, wasting attempts on an unfixable failure
@Step({ retries: 5 })
async charge(order: Order) {
  if (order.card.declined) throw new Error('declined'); // retried 5x
}

// ✓ Correct — FatalError fails the run immediately, no further attempts
import { FatalError } from '@dudousxd/nestjs-durable-core';

@Step({ retries: 5 })
async charge(order: Order) {
  if (order.card.declined) throw new FatalError('declined', 'card_declined');
}
```

Any thrown error is retried to the step's limit; only `FatalError` short-circuits retries.
Source: packages/core/src/workflow-ctx.ts (`step` retry loop), packages/core/src/errors.ts.
