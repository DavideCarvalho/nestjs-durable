---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable": patch
"@dudousxd/nestjs-durable-testing": patch
"@dudousxd/nestjs-durable-transport-db": patch
---

A wake that lands while its run's turn is still executing on another instance is no longer lost until the run's `reconcileMs` wake (5 minutes by default).

- **The wake is kept for the turn.** A wake that cannot take the run's lease because a turn of the run is executing elsewhere (a signal, a child's completion, a step result) records a durable request, and the instance running that turn takes it after it releases the lease and runs the next turn. Before, the instance that received the wake looked again once, found the turn still running and gave up. Runs waiting on a fan of children were covered by a re-check after the turn, but a run waiting on a signal, or on a `ctx.child` whose completion had been overwritten, waited for its reconcile wake.
- **`ctx.child` writes its timeline placeholder before it starts the child.** A child that finished before the placeholder was written had its completion overwritten by it, and the parent then saw the child as still running.
- The shared run-dispatch contract (`runRunDispatchContract`) checks a child's completion, a fan's completions and a signal landing mid-turn on the other instance, for every transport.
- **The SQL transport retries a statement the database rolled back to break a deadlock** (`ER_LOCK_DEADLOCK` on MySQL, `40P01` on Postgres) when it queues, takes or deletes a run, and queues a batch in run-id order. Queueing a batch while another instance took or deleted the same runs could deadlock on MySQL: the starts then waited for the next poll and the wakes resumed on the instance that raised them.
