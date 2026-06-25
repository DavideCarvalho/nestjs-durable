---
name: durable-signals-and-timers
description: >
  Pause and resume @dudousxd/nestjs-durable workflows — ctx.waitForSignal(token) resumed by
  WorkflowService.signal(token, payload), ctx.waitForEvent(name, { match }) resumed by
  publishEvent(name, payload), @OnEvent / @Workflow({ onEvent }) event-triggered starts,
  durable ctx.sleep(duration) / ctx.sleepUntil(date), ctx.webhook() for third-party callbacks, and
  signalWithStart for the durable-entity/accumulator pattern. Covers the timeoutMs determinism caveat.
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-durable"
  library_version: 0.22.0
  framework: nestjs
---

# Signals, events & durable timers

Workflows pause on durable primitives and resume when an external event arrives — a signal, a named
event, a timer, or a webhook callback. The run is `suspended` (consuming nothing) while it waits and
survives restarts.

## Setup

Inside a workflow body you await the wait primitive; outside (a controller, a webhook) you deliver
via `WorkflowService`:

```ts title="approval.workflow.ts"
import { Workflow } from '@dudousxd/nestjs-durable';
import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';

@Workflow({ name: 'approval', version: '1' })
export class ApprovalWorkflow {
  async run(ctx: WorkflowCtx, order: { id: string }) {
    await ctx.step('request', () => this.notify(order.id));
    // Pause until someone signals this token (or 24h passes).
    const decision = await ctx.waitForSignal<{ approved: boolean }>(
      `approve:${order.id}`,
      { timeoutMs: 24 * 60 * 60 * 1000 },
    );
    return decision.approved ? 'shipped' : 'rejected';
  }
}
```

```ts title="approval.controller.ts"
import { WorkflowService } from '@dudousxd/nestjs-durable';

@Controller('approvals')
export class ApprovalController {
  constructor(private readonly workflows: WorkflowService) {}

  @Post(':orderId')
  approve(@Param('orderId') orderId: string, @Body() body: { approved: boolean }) {
    return this.workflows.signal(`approve:${orderId}`, body); // resumes the suspended run
  }
}
```

## Core patterns

### Signals (point-to-point) vs events (named pub/sub)

- `ctx.waitForSignal<T>(token, { timeoutMs? })` waits on an exact `token`; deliver with
  `workflows.signal(token, payload)`. One token, one waiting run.
- `ctx.waitForEvent<T>(name, { match?, timeoutMs? })` waits on a named event with optional `match`
  filtering; `workflows.publishEvent(name, payload)` fans out to every run whose `match` the payload
  satisfies (and starts any `@OnEvent` workflows). Returns how many runs it touched.

```ts
const order = await ctx.waitForEvent<Order>('order.paid', { match: { orderId: id } });
// elsewhere: await workflows.publishEvent('order.paid', { orderId: id, amount });
```

### Event-triggered workflow starts

`@Workflow({ onEvent })` or `@OnEvent(...)` start a **fresh run** whenever the event is published —
the payload becomes the run's input. `debounce` / `batch` coalesce bursts.

```ts
import { Workflow, OnEvent } from '@dudousxd/nestjs-durable';

@OnEvent('user.registered', 'user.invited')
@Workflow({ name: 'welcome', version: '1', debounce: '30s' })
export class WelcomeWorkflow {
  async run(ctx: WorkflowCtx, user: { id: string }) { /* ... */ }
}
```

### Durable timers

`ctx.sleep(duration)` and `ctx.sleepUntil(date)` suspend the run durably — a 7-day sleep survives any
number of restarts; the timer poller resumes it when due. `duration` accepts `ms`-style strings.

```ts
await ctx.step('draft', () => this.draft());
await ctx.sleep('7 days');           // durable — not setTimeout
await ctx.step('send', () => this.send());
```

### Webhooks (third-party callbacks)

`ctx.webhook()` mints a stable token + url **before** suspending, so you can hand the url to a third
party, then `await wh.wait()` for the callback (delivered as `signal(token, body)`). Configure
`webhookUrl` on the module to populate `wh.url`.

```ts
const wh = ctx.webhook<{ status: string }>();
await ctx.step('register', () => this.provider.callMeBack(wh.url)); // url is ready now
const result = await wh.wait();                                     // resumes on the callback
```

### signalWithStart — the accumulator pattern

`signalWithStart` ensures a run exists, then delivers a signal race-free — one long-lived run per key
fed by many calls.

```ts
await this.workflows.signalWithStart(
  AggregatorWorkflow,
  { key },
  `aggregator:${key}`,                 // stable runId
  { token: `event:${key}`, payload: event },
);
```

## Common mistakes

### 1. Using setTimeout / a cron instead of ctx.sleep

```ts
// ✗ Wrong — a real timer is lost on restart; the delay is not durable
async run(ctx, input) {
  await new Promise((r) => setTimeout(r, 7 * 86_400_000)); // gone if the process restarts
  await ctx.step('send', () => this.send());
}

// ✓ Correct — a durable timer the engine persists and resumes when due
async run(ctx, input) {
  await ctx.sleep('7 days');
  await ctx.step('send', () => this.send());
}
```

`ctx.sleep`/`sleepUntil` record a durable timer checkpoint and suspend; the timer poller resumes the
run — a raw `setTimeout` dies with the process. Source: packages/core/src/workflow-ctx.ts
(`sleep`, `sleepUntil`, `suspendUntil`).

### 2. Adding `{ timeoutMs }` to a live waitForSignal

```ts
// A run started under this (unbounded wait = 1 logical position):
await ctx.waitForSignal('approve');

// ✗ Wrong — adding a timeout makes it consume TWO positions, shifting every later step's seq
await ctx.waitForSignal('approve', { timeoutMs: 60_000 }); // in-flight runs corrupt

// ✓ Correct — treat the timeout change as a new @Workflow version
@Workflow({ name: 'approval', version: '2' })
```

A bounded wait consumes two logical positions (deadline + wait), an unbounded one consumes one, so
toggling `timeoutMs` is a positional (versioned) change. Source: packages/core/src/workflow-ctx.ts
(determinism note above `consumeBuffered`).

### 3. Signalling a token that doesn't match the waiting run

```ts
// Workflow waits on a per-order token:
await ctx.waitForSignal(`approve:${order.id}`);

// ✗ Wrong — signalling a different token leaves the run suspended forever
await this.workflows.signal('approve', body);

// ✓ Correct — the signal token must match the waited token exactly
await this.workflows.signal(`approve:${order.id}`, body);
```

`signal(token, payload)` resolves only the run waiting on that exact token; a mismatched token is
buffered and the run never wakes. Source: packages/nestjs/src/workflow.service.ts (`signal`),
packages/core/src/workflow-ctx.ts (`waitForSignal`).
