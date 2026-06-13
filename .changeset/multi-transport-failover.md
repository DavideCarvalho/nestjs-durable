---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

feat: multiple transports with failover + per-step selection

The engine now accepts an ordered `transports` pool (`[{ id, transport }]`): it dispatches on the
first and **fails over to the next on a dispatch error**, and a step can pin one with
`ctx.call(step, input, { transport: 'sqs' })`. The chosen transport id is stamped on the
`RemoteTask` (`task.transport`) so a worker that consumes several transports replies on the matching
one — failover stays symmetric without the worker ever choosing a transport. Results/heartbeats are
consumed from every transport in the pool. `transport` (single) remains as shorthand for a one-entry
pool; the NestJS module exposes `transports`. Cross-language note: run one worker/runner per broker
and the matching one handles each failover hop and replies on its own broker — no worker change
needed; `task.transport` is there for processes that multiplex brokers.
