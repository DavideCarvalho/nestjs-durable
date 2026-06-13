---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

feat: flow control — durable queues for remote steps

`engine.registerQueue({ name, concurrency, rateLimit })` (or the NestJS module's `queues` option)
caps how much work `ctx.call(step, input, { queue })` admits at once — a concurrency limit and/or a
fixed-window rate limit. A call that can't be admitted does **not** dispatch: the run re-suspends
with the queue's retry time and the timer poller re-tries admission later, so the limit is durable
(survives crashes) without holding the run in memory. Accounting is per engine instance (the DBOS
`workerConcurrency` tier); global cross-instance limits remain a follow-up needing a durable counter.
