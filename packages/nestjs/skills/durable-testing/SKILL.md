---
name: durable-testing
description: >
  Unit-test @dudousxd/nestjs-durable workflows with @dudousxd/nestjs-durable-testing — createTestEngine
  gives an in-memory engine/store/transport + a controllable clock. Start runs with engine.start +
  waitForRun, advance durable sleeps with tick(ms), inject failures with failOnce/failTimes to drive
  retries, and assert with assertRunStatus, assertOutput, assertStepsRan, assertStepAttempts,
  recordedSteps. No Postgres, no Redis, no real time.
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

t.engine.register('checkout', '1', async (ctx) => {
  await ctx.step('reserve', () => ({ reserved: true }));
  return ctx.step('ship', () => ({ shipped: true }));
});

const { runId } = await t.engine.start('checkout', { id: 'o1' }, 'run1'); // enqueues → pending
await t.engine.waitForRun(runId);                                         // settles
await assertRunStatus(t.store, 'run1', 'completed');
await assertOutput(t.store, 'run1', { shipped: true });
```

`createTestEngine()` returns `{ engine, store, transport, clock, tick, run }`. Use the raw
`engine.register(name, version, body)` to register a workflow body directly (no NestJS DI needed in a
unit test), or wire a real `@Workflow` provider via a Nest testing module when you want DI.

## Core patterns

### Control durable time with tick(ms)

`tick(ms)` advances the clock and resumes any durable sleep now due — a 7-day sleep is tested
instantly.

```ts
t.engine.register('digest', '1', async (ctx) => {
  await ctx.step('draft', () => draft());
  await ctx.sleep('7 days');
  await ctx.step('send', () => send());
});

const { runId } = await t.engine.start('digest', {}, 'run1');
await t.engine.waitForRun(runId);                 // settles on the durable sleep → suspended
await t.tick(7 * 24 * 60 * 60 * 1000);            // the sleep is now due → completes
await assertRunStatus(t.store, 'run1', 'completed');
```

### Inject crashes and drive retries

`failOnce(value)` / `failTimes(n, value)` make a step throw before finally returning `value` — to
exercise `retries` and resume.

```ts
import { failOnce, assertStepAttempts } from '@dudousxd/nestjs-durable-testing';

t.engine.register('wf', '1', async (ctx) =>
  ctx.step('charge', failOnce({ ok: true }), { retries: 3 }),
);
const { runId } = await t.engine.start('wf', {}, 'run1');
await t.engine.waitForRun(runId);
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

### 1. Expecting `start` to run the body synchronously in a test

```ts
// ✗ Wrong — start only enqueues; the run is still 'pending' here
await t.engine.start('checkout', input, 'run1');
await assertRunStatus(t.store, 'run1', 'completed'); // fails — body hasn't run yet

// ✓ Correct — wait for the run to settle (or use t.run(...) which starts + waits)
const { runId } = await t.engine.start('checkout', input, 'run1');
await t.engine.waitForRun(runId);
await assertRunStatus(t.store, 'run1', 'completed');
```

`start` enqueues and returns `{ status: 'pending' }`; the body runs asynchronously, so pair it with
`waitForRun` (or the harness's `run`). Source: packages/testing/src/harness.ts (`createTestEngine`).

### 2. Using real time instead of tick() for a durable sleep

```ts
// ✗ Wrong — the durable sleep is suspended; real time never advances the engine's clock
await t.engine.start('digest', {}, 'run1');
await new Promise((r) => setTimeout(r, 1000)); // run stays suspended forever

// ✓ Correct — advance the controllable clock so the sleep becomes due
await t.engine.start('digest', {}, 'run1');
await t.engine.waitForRun('run1'); // suspends on the sleep
await t.tick(7 * 24 * 60 * 60 * 1000);
```

The test engine uses a `MutableClock`; only `tick(ms)` advances it and resumes due timers.
Source: packages/testing/src/harness.ts (`tick`, `MutableClock`).

### 3. Reusing the same runId across cases expecting a fresh run

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
