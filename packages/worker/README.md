# @dudousxd/durable-worker

A **control-plane-less** durable worker for Node — the Node analog of the Python `durable-worker`. It lets a plain Node or NestJS service be a **pure worker**: no store, no engine, no recovery, no dashboard. It consumes tasks from the [`@dudousxd/nestjs-durable`](../nestjs) engine over BullMQ, runs your step handlers and replays your workflow bodies, and returns `StepResult`/`WorkflowDecision` over the wire.

## Why

A `@dudousxd/nestjs-durable` `DurableModule` with `worker: true` is a **full engine instance** (store + recovery + in-process execution). Running several of those means several control planes contending on one store. This package is the missing **thin** worker: the single engine stays the sole owner of all durable state, and N thin workers — Python *and* Node — just execute and report back.

```
   ┌─ Control plane (1) ─┐     BullMQ/Redis      thin workers (N)
   │ Nest engine + store │  ── tasks ──▶         consume → run/replay → return
   │ recovery + dashboard │ ◀── results/decisions ──  (no store/engine/recovery)
   └──────────────────────┘
```

## Use it from NestJS (recommended)

```ts
import { DurableWorkerModule } from '@dudousxd/nestjs-durable';

@Module({
  imports: [
    DurableWorkerModule.forRoot({
      connection: process.env.REDIS_URL!,
      groups: ['processing'], // the worker groups this process serves
    }),
  ],
  providers: [MyWorkflow, MyStepHandlers],
})
export class WorkerAppModule {}
```

`DurableWorkerModule` discovers your `@Workflow` classes and `@DurableStep` methods and runs them on the thin worker — **no `WorkflowEngine` or store is bound**. The same `@Workflow` you run in-process on the engine runs unchanged here (its body is typed against `WorkflowCtx`, which this package's `WorkflowContext` implements).

## Use it standalone (plain Node)

```ts
import { DurableWorkerRuntime, runRedisWorker } from '@dudousxd/durable-worker';

const runtime = new DurableWorkerRuntime();
runtime.registerStep('ingest', async (input, log) => {
  log.info('ingesting');
  return await ingest(input);
});
runtime.registerWorkflow('pipeline', async (ctx, input) => {
  const key = await ctx.step('setup', async () => `/${input}/data.csv`);
  const rows = await ctx.call(ingestStep, { key });
  return { rows };
});

const worker = await runRedisWorker({ runtime, group: 'pipeline', connection: process.env.REDIS_URL! });
// ... on shutdown:
await worker.close();
```

## Supported ops & parity

`WorkflowContext implements WorkflowCtx`, so workflow bodies are portable between the engine and the thin worker. The **wire-expressible** ops are fully supported:

`step` · `call` · `sleep` · `waitForSignal` (unbounded) · `child` · `all` · `now` / `random` / `uuid` — plus a `gather(items)` extension for parallel local steps (parity with the Python worker).

Ops that need engine/store features the remote wire protocol can't express **throw `UnsupportedOnThinWorker`** (run those workflows in-process on the engine): `transaction`, `callEntity`, `signalEntity`, `continueAsNew`, `sleepUntil`, `waitForEvent`, `task`, fire-and-forget `startChild`, `breakpoint`, `webhook`, `setEvent`, `onUpdate`, `patched`, and bounded `waitForSignal({ timeoutMs })` (the worker owns no timers, and a bounded wait would break seq-parity with the engine).

A conformance test verifies the same `@Workflow` produces identical output and ordered `(seq, name, kind)` on the engine and the thin worker.

## Install

```sh
pnpm add @dudousxd/durable-worker
# peer (optional): the BullMQ transport for the runner
pnpm add bullmq ioredis
```
