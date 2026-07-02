---
name: durable-testing
description: >
  Unit-test @dudousxd/nestjs-durable workflows with @dudousxd/nestjs-durable-testing — createTestEngine
  gives an in-memory engine/store/transport + a controllable clock. Register a workflow body with
  engine.register, serve its dispatched ctx.step calls with transport.handle, start runs with
  engine.start + waitForRun, advance durable sleeps with tick(ms), inject failures with
  failOnce/failTimes to drive retries, and assert with assertRunStatus, assertOutput, assertStepsRan,
  assertStepAttempts, recordedSteps. No Postgres, no Redis, no real time.
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-durable"
  library_version: 0.22.0
  framework: nestjs
---

# Testing durable workflows

`@dudousxd/nestjs-durable-testing` runs a whole workflow in a unit test against an in-memory store and
transport, with a clock you control and assertions that read the recorded state back. No external
infrastructure, no real waiting.

Every `ctx.step` is dispatched — even in a test — so a step needs a fake worker handler registered on
the test transport before the run reaches it.

## Setup

```bash
pnpm add -D @dudousxd/nestjs-durable-testing
```

```ts title="checkout.spec.ts"
import {
  createTestEngine,
  assertRunStatus,
  assertOutput,
} from '@dudousxd/nestjs-durable-testing';

const t = createTestEngine(); // { engine, store, transport, clock, tick, run }

t.transport.handle('reserve', async () => ({ reserved: true })); // fake worker for the dispatched step
t.transport.handle('ship', async () => ({ shipped: true }));

t.engine.register('checkout', '1', async (ctx) => {
  await ctx.step('reserve', { id: 'o1' });
  return ctx.step('ship', { id: 'o1' });
});

const { runId } = await t.engine.start('checkout', { id: 'o1' }, 'run1'); // enqueues → pending
const result = await settle(t, runId);                                   // see "Settling a run" below
await assertRunStatus(t.store, 'run1', 'completed');
await assertOutput(t.store, 'run1', { shipped: true });
```

`createTestEngine()` returns `{ engine, store, transport, clock, tick, run }`. Use the raw
`engine.register(name, version, body)` to register a workflow body directly (no NestJS DI needed in a
unit test) and `transport.handle(name, (input, log) => output)` to serve each `ctx.step` it dispatches
by name — or wire real `@Workflow`/`@Step` providers via a Nest testing module when you want DI.

## Core patterns

### Settling a run — a dispatched ctx.step suspends between hops

Because every step is dispatched (even against the in-memory transport), a run legitimately goes
`suspended` after EACH step and resumes asynchronously once its fake handler resolves — so a single
`waitForRun` call after `start` often returns mid-chain, not at the run's actual resting point. Poll
until the status stops changing:

```ts
import type { RunResult } from '@dudousxd/nestjs-durable-core';
import type { TestEngine } from '@dudousxd/nestjs-durable-testing';

async function settle(t: TestEngine, runId: string, max = 20): Promise<RunResult> {
  let last: RunResult = { runId, status: 'pending' } as RunResult;
  for (let i = 0; i < max; i += 1) {
    await new Promise((r) => setImmediate(r)); // let a pending transport.handle result land
    last = await t.engine.waitForRun(runId);
    if (last.status !== 'suspended') return last;
  }
  return last; // still suspended after `max` hops — a real wait (sleep/signal), not more dispatch
}
```

A workflow whose OWN resting point is `suspended` (a durable sleep, `waitForSignal`) returns that
status from `settle` too — assert on it directly, same as the non-dispatched case.

### Control durable time with tick(ms)

`tick(ms)` advances the clock and resumes any durable sleep now due — a 7-day sleep is tested
instantly.

```ts
t.transport.handle('draft', async () => undefined);
t.transport.handle('send', async () => undefined);
t.engine.register('digest', '1', async (ctx) => {
  await ctx.step('draft', {});
  await ctx.sleep('7 days');
  await ctx.step('send', {});
});

const { runId } = await t.engine.start('digest', {}, 'run1');
await settle(t, runId);                           // rests on the durable sleep → suspended
await assertRunStatus(t.store, 'run1', 'suspended');
await t.tick(7 * 24 * 60 * 60 * 1000);             // the sleep is now due → resumes
await settle(t, runId);
await assertRunStatus(t.store, 'run1', 'completed');
```

### Inject crashes and drive retries

`failOnce(value)` / `failTimes(n, value)` build a fake handler that throws before finally returning
`value` — hand it straight to `transport.handle` to exercise `retries` and resume. A zero/omitted
`backoffMs` still needs a timer sweep to notice the retry is due, so `tick(0)` after the failure.

```ts
import { failOnce, assertStepAttempts } from '@dudousxd/nestjs-durable-testing';

t.transport.handle('charge', failOnce({ ok: true }));
t.engine.register('wf', '1', async (ctx) => ctx.step('charge', {}, { retries: 3 }));

const { runId } = await t.engine.start('wf', {}, 'run1');
await settle(t, runId);
await t.tick(0); // due retries (even a zero backoff) resume on the next timer sweep
await settle(t, runId);
await assertStepAttempts(t.store, 'run1', 'charge', 2); // failed once, then succeeded
```

### Assertions

All assertions read the store, so they work against any run the engine produced:

- `assertRunStatus(store, runId, status)` — terminal/suspended status.
- `assertOutput(store, runId, expected)` — the run's final output.
- `assertStepsRan(store, runId, names)` — which steps recorded checkpoints.
- `assertStepAttempts(store, runId, stepName, attempts)` — attempt count for retries.
- `recordedSteps(store, runId)` — the list of recorded step names.

## Common mistakes

### 1. Forgetting to register a transport.handle for a dispatched step

```ts
// ✗ Wrong — no fake worker for 'reserve'; the step fails with "no handler for reserve"
t.engine.register('checkout', '1', async (ctx) => ctx.step('reserve', {}));
await t.engine.start('checkout', {}, 'run1');

// ✓ Correct — every ctx.step name the body dispatches needs a matching transport.handle
t.transport.handle('reserve', async () => ({ reserved: true }));
t.engine.register('checkout', '1', async (ctx) => ctx.step('reserve', {}));
```

`ctx.step` is always dispatched — even in a test against the in-memory transport — so there is no
"local" step that just runs inline. Source: packages/core/src/testing/in-memory-transport.ts (`handle`).

### 2. Expecting one waitForRun to reach a multi-step run's terminal state

```ts
// ✗ Wrong — resolves on the FIRST dispatched step's pending suspend, not the run's end state
const { runId } = await t.engine.start('checkout', input, 'run1');
await t.engine.waitForRun(runId);
await assertRunStatus(t.store, 'run1', 'completed'); // often fails — still 'suspended' mid-chain

// ✓ Correct — poll until the status stops changing (see "Settling a run" above)
const { runId } = await t.engine.start('checkout', input, 'run1');
await settle(t, runId);
await assertRunStatus(t.store, 'run1', 'completed');
```

`waitForRun` resolves on the FIRST settled event, and a dispatch-pending suspend counts as settled —
a run with several dispatched steps in sequence settles once per step. Source:
packages/core/src/engine.ts (`waitForRun`).

### 3. Using real time instead of tick() for a durable sleep

```ts
// ✗ Wrong — the durable sleep is suspended; real time never advances the engine's clock
await t.engine.start('digest', {}, 'run1');
await new Promise((r) => setTimeout(r, 1000)); // run stays suspended forever

// ✓ Correct — advance the controllable clock so the sleep becomes due
await t.engine.start('digest', {}, 'run1');
await settle(t, 'run1'); // suspends on the sleep
await t.tick(7 * 24 * 60 * 60 * 1000);
```

The test engine uses a `MutableClock`; only `tick(ms)` advances it and resumes due timers.
Source: packages/testing/src/harness.ts (`tick`, `MutableClock`).

### 4. Reusing the same runId across cases expecting a fresh run

```ts
// ✗ Wrong — start is idempotent by runId; reusing 'run1' returns the existing run, not a new one
await t.engine.start('wf', a, 'run1');
await t.engine.start('wf', b, 'run1'); // same run — input b is ignored

// ✓ Correct — give each logical run a distinct id (or omit it for a random one)
await t.engine.start('wf', a, 'run1');
await t.engine.start('wf', b, 'run2');
```

A `runId` makes `start` idempotent (a redelivery returns the existing run), so distinct cases need
distinct ids. Source: packages/nestjs/src/workflow.service.ts (`start` idempotency by `runId`).
