# Skill spec — nestjs-durable (autonomous pass)

Scope: the single primary client-facing package `@dudousxd/nestjs-durable` (packages/nestjs).
A NestJS app imports this module; everything else in the monorepo is an adapter (stores,
transports), observability, codegen/cli, or the Python worker SDK. Flat skill set, no router.

## Skills (5, all type `core`, library `@dudousxd/nestjs-durable`, framework `nestjs`)

1. **durable-setup** — Install the packages, register `DurableModule.forRootAsync` with a store +
   transport, register `@Workflow`/`@DurableStep` providers, start runs with `WorkflowService`.
   Covers the zero-infra event-emitter default, `start` (enqueue) vs `waitForRun` (settle), and the
   `worker:false` API/worker split. Source: getting-started.mdx, durable.module.ts, workflow.service.ts.

2. **durable-workflows** — Author a workflow body: `@Workflow`, `run(ctx, input)`, local
   `ctx.step(name, fn, opts)`, typed remote `remoteStep` + `ctx.call` handled by `@DurableStep`,
   step retries/`FatalError`, `Promise.all` fan-out, saga `compensate`, tags. Source:
   workflows-and-steps.mdx, decorators.ts, remote-step-factory.ts, workflow-ctx.ts, interfaces.ts.

3. **durable-determinism** — THE correctness rule: the body re-runs on replay, so non-determinism
   (`Date.now`, `Math.random`, raw IO) must live in steps; use `ctx.now/random/uuid`; `@Workflow`
   `version` + side-by-side registration for breaking changes; idempotency of remote steps. Source:
   durability.mdx, workflow-ctx.ts (NonDeterminismError, now/random/uuid).

4. **durable-signals-and-timers** — Pause/resume primitives: `ctx.waitForSignal` + `signal`,
   `ctx.waitForEvent` + `publishEvent`, `@OnEvent`/`onEvent` triggers, durable `ctx.sleep`/
   `sleepUntil`, `ctx.webhook()`. Determinism caveat: adding `{ timeoutMs }` shifts seqs. Source:
   workflow-ctx.ts, workflow.service.ts, decorators.ts.

5. **durable-testing** — Unit-test workflows with `@dudousxd/nestjs-durable-testing`:
   `createTestEngine`, `engine.start` + `waitForRun`, `tick(ms)` for durable sleep, `failOnce`/
   `failTimes` for retries, `assertRunStatus`/`assertOutput`/`assertStepAttempts`. Source:
   testing.mdx, packages/testing/src/{harness,assertions,steps}.ts.

## Remaining Gaps (what a maintainer interview would have answered)

- No maintainer available (fully autonomous): skill priority order is inferred from README/doc
  ordering, not confirmed.
- `gh search issues` returned no accessible results — real failure-mode FAQ not mined.
- README "Quick look" `@Step()` decorator is NOT real; skills use the grounded `ctx.step(...)` form.
- Production tuning (leaseMs, retention windows, transport choice per scale) is generic, not
  deployment-tuned.
- Out of scope (listed but not skilled): stores (mikro-orm/typeorm/prisma/drizzle), transports
  (bullmq/sqs/db), otel, telescope, dashboard, codegen, cli, admission-redis, Python `durable-worker`.
- The testing package is public and could host its own skills folder; here its helpers are taught
  from the nestjs package skill instead.
