# @dudousxd/nestjs-durable-transport-db

A **database-backed `Transport`** for [nestjs-durable](https://github.com/DavideCarvalho/nestjs-durable) —
DBOS-style. Remote steps (`ctx.call`) travel as **rows in the database you already use for durable
state**, not through a broker. Dispatch inserts a task row; a worker claims it with
`SELECT … FOR UPDATE SKIP LOCKED`, runs it, and writes a result row the engine polls.

**Why:** it's the "`ctx.call` with zero new infrastructure" option. No Redis, no SQS, no new queue —
the DB is the queue. The right fit when you can't (or won't) add a broker.

**Trade-off:** throughput is bounded by polling + row contention. Excellent for workflow/pipeline
scale (modest rate, long steps); not for high-fanout firehoses — use the BullMQ transport there.

**Requires** `FOR UPDATE SKIP LOCKED`: **MySQL 8+** or **Postgres 9.5+** (not SQLite).

## Install

```bash
pnpm add @dudousxd/nestjs-durable-transport-db
```

## It rides the ORM your app already has

`DbTransport` takes a small `SqlExecutor` — build it from your app's own connection. Adapters ship
for **MikroORM** and **TypeORM**; implement `SqlExecutor` for anything else.

```ts
import { DbTransport, mikroOrmExecutor, typeOrmExecutor } from '@dudousxd/nestjs-durable-transport-db';

// MikroORM (the app's EntityManager)
new DbTransport({ executor: mikroOrmExecutor(em), group: 'extraction' });

// TypeORM (e.g. the same DataSource the durable store uses)
new DbTransport({ executor: typeOrmExecutor(dataSource), group: 'extraction' });
```

## NestJS wiring

Build the transport in `DurableModule.forRootAsync` from a DI-injected connection — one engine-side
instance (dispatches + consumes results), one per worker process (registers its `group`):

```ts
import { MikroORM } from '@mikro-orm/core';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { DbTransport, mikroOrmExecutor } from '@dudousxd/nestjs-durable-transport-db';
import { MyStateStore } from './store';

@Module({
  imports: [
    DurableModule.forRootAsync({
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => {
        const transport = new DbTransport({
          executor: mikroOrmExecutor(orm.em.fork()),
          group: process.env.DURABLE_GROUP, // worker side: 'extraction' / 'ingestion'; engine side: omit
          autoCreate: true, // create durable_transport_tasks/_results on first use (dev)
        });
        return { store: new MyStateStore(/* … */), transport, autoSchema: true };
      },
    }),
  ],
})
export class AppModule {}
```

Workers register handlers with the `@DurableStep('name')` decorator (from `@dudousxd/nestjs-durable`)
— the registrar wires them onto the transport's `group`. On shutdown, call `transport.close()` to
stop the pollers (wire it to `OnModuleDestroy`).

## Options

| Option | Default | Notes |
|---|---|---|
| `executor` | — | Required. `mikroOrmExecutor(em)` / `typeOrmExecutor(ds)` / custom. |
| `group` | — | Required to register `handle()`s (worker side). |
| `prefix` | `durable` | Tables: `${prefix}_transport_tasks` / `_results`. |
| `pollMs` | `500` | Poll interval when the queue is empty. |
| `leaseMs` | `30000` | How long a claimed row is owned before it's reclaimable (crash recovery). |
| `batchSize` | `10` | Max rows claimed per poll. |
| `autoCreate` | `true` | Create the two tables on first use. |

## Semantics

- **At-least-once.** A task whose worker crashes before writing its result reappears after the lease
  expires (durable retry). A duplicate `StepResult` is harmless — the engine resolves a step's
  pending call exactly once by `stepId`.
- **No double-claim.** `FOR UPDATE SKIP LOCKED` means concurrent instances skip each other's locked
  rows instead of blocking.
- **Idempotency.** A step's `stepId` (`runId:seq`) is deterministic — workers can use it as the
  idempotency key to dedupe side effects under redelivery.
