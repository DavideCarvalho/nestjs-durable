---
'@dudousxd/nestjs-durable': minor
---

Integrate the first-party `@nestjs/outbox` and `@nestjs/locks`, both optional peers (nothing changes for an app that installs neither):

- **`@dudousxd/nestjs-durable/outbox`** — a new subpath (it alone loads `@nestjs/outbox`). `DurableOutboxModule.forRoot({ topic?, consumer? })` next to the official `OutboxModule`, and the injectable `DurableOutbox`: `start(tx, workflow, input, { runId?, ...StartOptions })` and `signal(tx, token, payload)` write the message through your own transaction, and an `@OnOutboxMessage` handler starts or signals the run after commit. A start is idempotent by run id on redelivery (a run id is chosen at write time when you give none); fatal engine errors dead-letter at once. `applyDurableOutboxMessage(engine, payload)` serves a consumer behind a broker.
- **Fleet-wide sweeps on one pod.** When the app imports `LocksModule` from `@nestjs/locks` (detected at init, logged once), retention pruning, the stalled-run pager and the buffered-signal cleanup each run under a held lease (`durable:<sweep>[:<namespace>]`) on one pod at a time, with failover when the holder stops renewing. Work-claiming sweeps stay on every pod.
