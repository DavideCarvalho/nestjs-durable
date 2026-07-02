---
name: durable-determinism
description: >
  The one correctness rule for @dudousxd/nestjs-durable workflows — the run(ctx, input) body re-runs
  top-to-bottom on recovery, so it must be deterministic. Keep Date.now/Math.random/IO out of the
  body and inside dispatched ctx.step calls; use ctx.now() for a checkpointed timestamp and
  ctx.sideEffect(fn) for any other non-deterministic capture (an id, a random draw). Covers
  positional replay, NonDeterminismError, @Workflow version pinning + side-by-side registration for
  breaking changes, exactly-once vs physical retry idempotency, and self-healing recovery.
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-durable"
  library_version: 0.22.0
  framework: nestjs
---

# Determinism & replay — the one rule

Durability comes from **checkpoint + deterministic replay**. On recovery the engine re-runs the
workflow body from the top; a step that already has a `completed` checkpoint returns its saved result
instead of executing again. For that to be safe, **the body must be deterministic** — all
non-determinism (clock, randomness, network, IO) lives inside a dispatched `ctx.step`, or one of the
two checkpointed capture helpers.

## Setup

There is nothing to install for this rule — it governs how you write `run(ctx, input)`. The two
capture helpers are checkpointed wrappers on `ctx`:

```ts
import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';

async run(ctx: WorkflowCtx, input: unknown) {
  const at = await ctx.now();                             // checkpointed clock — same value on every replay
  const id = await ctx.sideEffect(() => crypto.randomUUID()); // checkpointed capture — author picks the generator
  // ...use these instead of the raw globals...
}
```

## Core patterns

### Side effects live in a dispatched step; the body is pure orchestration

```ts
// ✓ The body only calls ctx.step and branches on results — real IO is inside a @Step handler.
async run(ctx: WorkflowCtx, order: Order) {
  const quote = await ctx.step(this.pricing.fetch, order);          // dispatched, checkpointed
  if (quote.total > 1000) await ctx.step(this.review.flag, order);
  await ctx.step(this.billing.charge, quote);
}
```

```ts
@Injectable()
export class PricingService {
  @Step()
  async fetch(order: Order) { /* real IO here */ }
}
```

The engine guarantees each step runs **exactly once logically**, even across crashes and deploys,
because re-running the body short-circuits completed checkpoints.

### Use ctx.now() / ctx.sideEffect(fn) for non-deterministic values

A raw `Date.now()` or `Math.random()` in the body produces a different value on each replay and
shifts later decisions, corrupting the run. `ctx.now()` captures the clock as a checkpoint on first
run and replays it verbatim; `ctx.sideEffect(fn)` does the same for anything else — `fn` runs ONCE
and its result is replayed thereafter (you pick the generator: `() => uuidv7()`, `() => ulid()`,
`() => Math.random()`, a config/env read).

### Version-pinned replay for breaking changes

Replay is **positional**: reordering or inserting steps while runs are in flight would corrupt them.
A run resumes on the `version` it started on, so during a breaking change register both versions side
by side — in-flight runs drain on the old, new runs start on the new.

```ts
@Workflow({ name: 'checkout', version: '1' })
export class CheckoutWorkflowV1 { /* old body, kept until in-flight runs drain */ }

@Workflow({ name: 'checkout', version: '2' })
export class CheckoutWorkflowV2 { /* new body */ }
```

A run whose version is no longer registered fails loudly rather than silently corrupting.

### Recovery is automatic and self-healing

`DurableModule` wires `engine.recoverIncomplete()` — it runs on boot **and** periodically (the
`TimerPoller`), so a run orphaned by a crashed worker is reclaimed within ~`leaseMs`. A live worker
renews its lease while running, so a long step is not reclaimed out from under it.

## Common mistakes

### 1. Reading the clock or randomness directly in the body

```ts
// ✗ Wrong — different value on every replay; downstream branches diverge
async run(ctx, order) {
  if (Math.random() < 0.1) await ctx.step(this.sampler.sample, order); // replays differently
  const ts = Date.now();                                              // changes each recovery
}

// ✓ Correct — checkpointed sources are stable across replays
async run(ctx, order) {
  if ((await ctx.sideEffect(() => Math.random())) < 0.1) {
    await ctx.step(this.sampler.sample, order);
  }
  const ts = await ctx.now();
}
```

The body re-runs on recovery; raw `Date.now()`/`Math.random()` are not checkpointed, so they shift
the replay. Source: packages/core/src/workflow-ctx.ts (`now`, `sideEffect`).

### 2. Editing a live workflow body without bumping `version`

```ts
// ✗ Wrong — insert a step into v1 while runs are in flight → positions shift, runs corrupt
@Workflow({ name: 'checkout', version: '1' })
class CheckoutWorkflow {
  async run(ctx, o) {
    await ctx.step(this.audit.log, o);   // NEW step inserted before existing ones
    await ctx.step(this.billing.charge, o);
  }
}

// ✓ Correct — ship the change as a new version, keep v1 registered until its runs drain
@Workflow({ name: 'checkout', version: '2' })
class CheckoutWorkflowV2 { /* new body */ }
```

Replay matches checkpoints by position; inserting/reordering steps under the same version throws a
`NonDeterminismError` for in-flight runs. Source: website/content/docs/concepts/durability.mdx
("Version-pinned replay"), packages/core/src/workflow-ctx.ts (`NonDeterminismError`).

### 3. Assuming a dispatched step physically runs exactly once

```ts
// ✗ Wrong — handler assumes it can never be called twice for the same step
@Step('payments.charge-card')
async charge(input: { orderId: string; amountCents: number }) {
  return { chargeId: await this.stripe.charge(input) }; // double-charge if checkpoint write is lost
}

// ✓ Correct — derive a stable idempotency key from the input itself (a @Step handler has no
// separate stepId parameter — it only receives `(input, log)`)
@Step('payments.charge-card')
async charge(input: { orderId: string; amountCents: number }) {
  return { chargeId: await this.stripe.charge(input, { idempotencyKey: input.orderId }) };
}
```

The engine guarantees *logical* exactly-once, but a crash after the worker ran and before its
checkpoint was written can physically re-run the step — dedupe on something stable in the input.
Source: website/content/docs/concepts/durability.mdx ("Idempotency").
