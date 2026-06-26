---
name: durable-workflows
description: >
  Author durable workflows with @dudousxd/nestjs-durable — @Workflow({ name, version }) classes with a
  run(ctx, input) body, local ctx.step(name, fn, opts) checkpoints, typed remote steps via remoteStep
  + ctx.call handled by @DurableStep('name'), step retries/backoff, FatalError to stop retrying,
  Promise.all fan-out, saga compensate undo callbacks, and run tags. Covers step vs ctx.call vs
  sub-process log.sub annotations and constructor dependency injection inside a workflow class.
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-durable"
  library_version: 0.22.0
  framework: nestjs
---

# Authoring durable workflows

A workflow is a provider decorated with `@Workflow`; its `run(ctx, input)` method is the
deterministic body the engine executes and replays. Work happens in **steps** — local
(`ctx.step`) or remote (`ctx.call`) — each a durable checkpoint.

## Setup

```ts title="checkout.workflow.ts"
import { Workflow, DurableStep } from '@dudousxd/nestjs-durable';
import { remoteStep, FatalError } from '@dudousxd/nestjs-durable-core';
import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

// 1. A typed remote step: the `name` is the contract a handler registers under.
export const chargeCard = remoteStep({
  name: 'payments.charge-card',
  input: z.object({ orderId: z.string(), amountCents: z.number().int() }),
  output: z.object({ chargeId: z.string() }),
  retries: 3,
});

// 2. The workflow — plain linear code; ctx primitives are the only durable surface.
@Workflow({ name: 'checkout', version: '1' })
export class CheckoutWorkflow {
  constructor(private readonly inventory: InventoryService) {} // normal DI

  async run(ctx: WorkflowCtx, order: { id: string; total: number }) {
    // Local step: runs in-process, checkpointed, retried up to `retries`.
    await ctx.step('reserveStock', () => this.inventory.reserve(order.id), { retries: 3 });
    // Remote step: dispatched over the transport, may run in another process/language.
    const charge = await ctx.call(chargeCard, { orderId: order.id, amountCents: order.total });
    return { chargeId: charge.chargeId };
  }
}

// 3. A provider method handles the remote step in-process (with an in-process transport).
@Injectable()
export class PaymentsWorker {
  @DurableStep('payments.charge-card')
  async charge(input: { orderId: string; amountCents: number }) {
    return { chargeId: `ch_${input.orderId}` };
  }
}
```

Register all three as providers (see the durable-setup skill).

## Core patterns

### Local step vs remote step

- `ctx.step(name, fn, opts?)` runs `fn` **here** and checkpoints its return value. Use for local IO
  (DB writes, calling a service the app owns).
- `ctx.call(remoteStep, input, opts?)` dispatches over the transport to a handler registered under
  the same `name` (a `@DurableStep` method, another process, or a Python worker). Inputs/outputs are
  validated against the `remoteStep` zod schemas at the boundary.

Both are first-class checkpoints: on crash/replay a `completed` one returns its saved result instead
of re-executing.

### Retries, backoff, and FatalError

Per-step retry config lives in `opts`; throw `FatalError` to stop retrying a business failure a retry
can't fix.

```ts
await ctx.step('charge', async () => {
  const res = await this.stripe.charge(order);
  if (res.declined) throw new FatalError('card declined', 'declined'); // fails the run now
  return res;
}, { retries: 5, backoff: 'exp', backoffMs: 200, jitter: true });
```

`StepOptions` fields: `retries`, `backoff` (`'fixed'` | `'exp'`), `backoffMs`, `backoffMaxMs`,
`jitter`, `timeoutMs` (remote liveness), `compensate` (saga).

### Fan-out and sagas

Run steps concurrently with `Promise.all` — each step's position is taken in the synchronous prefix,
so replay stays deterministic:

```ts
const [a, b] = await Promise.all([
  ctx.step('a', () => doA()),
  ctx.step('b', () => doB()),
]);
```

Register a saga `compensate` undo on a step; if the run later fails, compensations run in reverse:

```ts
await ctx.step('reserve', () => this.inventory.reserve(id), {
  compensate: () => this.inventory.release(id), // runs on later run failure, newest-first
});
```

### Steps vs sub-process events

A `ctx.step` / `ctx.call` is a durable, independently-replayed checkpoint. For pure visibility
*inside* one step, emit sub-process events on the step logger — they are annotations, not
checkpoints, and re-run if the step retries:

```ts
await ctx.step('process-batch', async (log) => {
  for (const item of batch) {
    await handle(item);
    log.sub(item.id, 'ok'); // shown under the step; NOT a separate checkpoint
  }
});
```

## Common mistakes

### 1. Doing durable work directly in the body instead of in a step

```ts
// ✗ Wrong — the write re-runs on every replay (not checkpointed)
async run(ctx, order) {
  await this.db.insert(order);        // re-executed each recovery → duplicate rows
  return { ok: true };
}

// ✓ Correct — wrap side effects in a step so they checkpoint and run exactly once logically
async run(ctx, order) {
  await ctx.step('persist', () => this.db.insert(order));
  return { ok: true };
}
```

Only `ctx.step`/`ctx.call`/`ctx.transaction` results are checkpointed; raw work in the body re-runs
on replay. Source: website/content/docs/concepts/durability.mdx.

### 2. Mismatching the remoteStep `name` and the @DurableStep handler

```ts
// ✗ Wrong — handler name ≠ the remoteStep name, so ctx.call(chargeCard) finds no handler
export const chargeCard = remoteStep({ name: 'payments.charge-card', /* ... */ });
@DurableStep('payments.charge')                 // typo / mismatch
async charge(input) { /* ... */ }

// ✓ Correct — the string is the contract; it must match byte-for-byte
@DurableStep('payments.charge-card')
async charge(input) { /* ... */ }
```

The `name` string is the routing contract between `remoteStep`/`ctx.call` and the handler.
Source: packages/core/src/remote-step-factory.ts, packages/nestjs/src/decorators.ts (`DurableStep`).

### 3. Throwing a plain Error when you meant to stop retrying

```ts
// ✗ Wrong — a plain Error is retried up to `retries`, wasting attempts on an unfixable failure
await ctx.step('charge', async () => {
  if (card.declined) throw new Error('declined'); // retried 5x
}, { retries: 5 });

// ✓ Correct — FatalError fails the run immediately, no further attempts
import { FatalError } from '@dudousxd/nestjs-durable-core';
await ctx.step('charge', async () => {
  if (card.declined) throw new FatalError('declined', 'card_declined');
}, { retries: 5 });
```

Any thrown error is retried to the step's limit; only `FatalError` short-circuits retries.
Source: packages/core/src/workflow-ctx.ts (`step` retry loop), packages/core/src/errors.ts.
