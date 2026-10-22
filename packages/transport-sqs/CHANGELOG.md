# @dudousxd/nestjs-durable-transport-sqs

## 0.2.1

### Patch Changes

- [#394](https://github.com/DavideCarvalho/nestjs-durable/pull/394) [`f67bea3`](https://github.com/DavideCarvalho/nestjs-durable/commit/f67bea3452672027aa5daed1a6797d548da440ee) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - SqsTransport's poll loops no longer stop consuming on the first failure, and a received batch no longer runs twice.

  - A result handler that throws, a result `SendMessage` that fails, a message body that isn't JSON or a failing queue-URL resolution is reported through the new `onError` option (default `console.error`) and the loop moves on. The message is not deleted: SQS redelivers it after its visibility timeout, and a redrive policy moves one that keeps failing to a DLQ. These used to reject the loop's promise (an unhandled rejection) and leave the instance consuming nothing.
  - Every message of a received batch is kept invisible (`ChangeMessageVisibility` every third of the timeout) while it waits or runs. The messages behind a slow one used to reappear and run on another worker.
  - A `taskQueueUrl` resolver is now called once per group and cached, as documented.
  - The backoff after a failing receive no longer leaves an `abort` listener behind on every call.

## 0.2.0

### Minor Changes

- 687face: Ecosystem improvements across the durable runtime, stores, transports, and tooling.

  ### Scheduling

  - **Schedule jitter + backfill.** Cron/interval schedules can now spread fire
    times with configurable jitter to avoid thundering-herd dispatch, and missed
    occurrences (e.g. while a worker was down) can be backfilled deterministically.

  ### Cancellation

  - **Cancel-by-event.** New `cancelWhere(filter)` cancels all matching runs by a
    declarative filter, complementing single-run cancellation.

  ### Search attributes

  - **Indexed search-attribute side-table pushdown.** Equality and range queries
    over search attributes are pushed down into an indexed side-table across every
    store — TypeORM, MikroORM, Prisma, Drizzle, and the in-memory store — instead
    of scanning and filtering in application code. The side-table is re-indexed on
    update so stale attribute values stop matching.

  ### Singleton admission

  - **Backpressure + notify-on-release + `maxQueueDepth`.** Singleton admission now
    applies backpressure with a configurable `maxQueueDepth`, and waiters are
    notified on release rather than polling.

  ### Queue

  - **Priority + per-key fairness.** The work queue supports per-message priority
    together with per-key fairness so that one busy key cannot starve others.

  ### Context propagation

  - **Opaque context carrier.** Context is now propagated through an opaque carrier,
    decoupling callers from the underlying transport/trace representation.

  ### Packaging

  - **Dual ESM/CJS publish.** Packages now ship both ESM and CJS builds. Decorator
    packages are built via SWC with `legacyDecorator` + `decoratorMetadata` to
    preserve emitted metadata; `testing`, `cli`, and `eslint-plugin` remain
    CJS/ESM as appropriate by design.

  ### Testing

  - **Testcontainers-backed integration specs.** BullMQ, SQS, DB, and Prisma now
    have testcontainers-backed integration specs that run under `test:db`, plus a
    fix to the BullMQ dispatch test shape.
