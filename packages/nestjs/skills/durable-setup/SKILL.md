---
name: durable-setup
description: >
  Set up @dudousxd/nestjs-durable in a NestJS app — DurableModule.forRootAsync with a StateStore
  + Transport, register @Workflow / @Step providers, and start runs with WorkflowService.
  Covers the zero-infra EventEmitterTransport + InMemoryStateStore default, start() enqueues vs
  waitForRun() settles, autoSchema, drive:false dashboard/API-only replicas, DurableModule as a
  thin worker (connection only, no store), forRoot vs forRootAsync, app.enableShutdownHooks for
  graceful drain.
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-durable"
  library_version: 0.22.0
  framework: nestjs
---

# Durable setup (NestJS module wiring)

Install `@dudousxd/nestjs-durable`, register `DurableModule` with a store + transport, declare your
workflow/step providers, and start runs with `WorkflowService`. The defaults below use zero
infrastructure (in-process transport, in-memory store) — swap the store/transport for production.

## Setup

Install the module plus its core peer, a transport, and zod (optional `@Step({ input, output })`
runtime schemas use it):

```bash
pnpm add @dudousxd/nestjs-durable @dudousxd/nestjs-durable-core \
  @dudousxd/nestjs-durable-transport-event-emitter @nestjs/event-emitter zod
```

Register the module. `forRootAsync` lets the factory inject providers (here `EventEmitter2`); the
module is `global`, so `WorkflowService` is injectable everywhere without re-importing.

```ts title="app.module.ts"
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Module } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { CheckoutWorkflow } from './checkout.workflow';
import { PaymentsWorker } from './payments.worker';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    DurableModule.forRootAsync({
      inject: [EventEmitter2],
      useFactory: (emitter: EventEmitter2) => ({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(emitter),
      }),
    }),
  ],
  providers: [CheckoutWorkflow, PaymentsWorker], // discovered by DurableModule on boot
})
export class AppModule {}
```

`@Workflow` and `@Step` providers are plain providers — list them in `providers` (or any
imported module) and `DurableModule`'s discovery registers them on the engine at boot.

Enable shutdown hooks so the engine drains in-flight runs on deploy:

```ts title="main.ts"
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks(); // engine releases run leases on OnApplicationShutdown
await app.listen(3000);
```

## Core patterns

### Start a run, then (optionally) wait for it

`start` **enqueues** the run and returns immediately with `{ runId, status: 'pending' }` — a worker
runs the body, so the HTTP handler never blocks. Pass the workflow **class** for a typed input.

```ts
import { WorkflowService } from '@dudousxd/nestjs-durable';

@Controller('checkout')
export class CheckoutController {
  constructor(private readonly workflows: WorkflowService) {}

  @Post()
  async checkout(@Body() order: Order) {
    const { runId } = await this.workflows.start(CheckoutWorkflow, order); // returns now
    return { runId };
  }

  @Post('sync')
  async checkoutSync(@Body() order: Order) {
    const { runId } = await this.workflows.start(CheckoutWorkflow, order);
    return this.workflows.waitForRun(runId); // resolves once the run settles
  }
}
```

### forRoot vs forRootAsync, and the production store/transport

`forRoot(options)` takes a static options object; `forRootAsync({ useFactory, inject })` builds them
from injected providers (a config service, an ORM connection). For production, swap the in-memory
store for an ORM `StateStore` and the event-emitter transport for BullMQ:

```ts
DurableModule.forRootAsync({
  inject: [MikroORM],
  useFactory: (orm: MikroORM) => ({
    store: new MikroOrmStateStore(orm),                // persists checkpoints to Postgres/MySQL
    transport: new BullMQTransport({ connection }),    // cross-process / Python steps
    autoSchema: false,                                 // run migrations instead in production
    leaseMs: 30_000,                                   // recovery lease > your longest resume step
  }),
});
```

### Split API pods from worker pods

`DurableModule.forRoot` is the ONE module; the role is inferred from which of `store`/`connection`
you pass — nothing else to configure. For scale, run dispatch-only pods and driving pods that share
only the database. An API pod's `start` only enqueues; driving pods poll and run the body.

```ts
// API / dashboard pod: enqueue-only, mounts the store but never processes or recovers workflows
DurableModule.forRoot({ store, transport, drive: false });

// Driving pod (default): runs the body, recovers orphaned runs, polls timers
DurableModule.forRoot({ store, transport /* drive: true is the default */ });
```

A store-less **thin worker** (no engine/store — just registered handlers over a connection) passes
`connection` with no `store`:

```ts
import { DurableModule } from '@dudousxd/nestjs-durable';

@Module({
  imports: [DurableModule.forRoot({ connection: 'redis://localhost:6379', partition: 'payments' })],
  providers: [PaymentsWorker], // @Step handlers this worker serves
})
export class WorkerAppModule {}
```

`partition` is an optional isolation suffix on this worker's queues — omit it for a single-tenant
deployment. An operator with no local body for a workflow dispatches to a live worker of the same
name automatically; there's no `groups`/`remoteByConvention` flag to opt into.

## Common mistakes

### 1. Expecting `start` to return the workflow's result

```ts
// ✗ Wrong — `start` enqueues; `result` is { runId, status: 'pending' }, never the run output
const result = await this.workflows.start(CheckoutWorkflow, order);
return result.output; // undefined

// ✓ Correct — await the outcome with waitForRun when you need it inline
const { runId } = await this.workflows.start(CheckoutWorkflow, order);
return this.workflows.waitForRun(runId); // resolves once the run settles
```

`start` creates the run as `'pending'` and a worker runs the body asynchronously; only `waitForRun`
resolves with the settled outcome. Source: packages/nestjs/src/workflow.service.ts.

### 2. Leaving `autoSchema` on in production

```ts
// ✗ Wrong — auto-creates durable tables on every boot against the prod DB
DurableModule.forRoot({ store, transport }); // autoSchema defaults to true

// ✓ Correct — disable it and create the schema from a migration
DurableModule.forRoot({ store, transport, autoSchema: false });
```

`autoSchema` defaults to `true` and calls `store.ensureSchema()` on boot — fine for dev, but in
production you want the store adapter's `ensure*DurableSchema()` run as a migration instead.
Source: packages/nestjs/src/durable.module.ts (`autoSchema`).

### 3. Forgetting to register the workflow/step as a provider

```ts
// ✗ Wrong — the class is decorated but never provided, so discovery never finds it
@Module({ imports: [DurableModule.forRoot({ store, transport })] })
export class AppModule {} // start('checkout', ...) → unknown workflow

// ✓ Correct — list it (or import a module that provides it)
@Module({
  imports: [DurableModule.forRoot({ store, transport })],
  providers: [CheckoutWorkflow, PaymentsWorker],
})
export class AppModule {}
```

`DurableModule` registers workflows/steps by scanning DI providers on boot; an unprovided class is
invisible to the engine. Source: packages/nestjs/src/durable.module.ts (DiscoveryModule + registrars).
