---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
"@dudousxd/nestjs-durable-testing": patch
---

Wide `ctx.all` fans survive crashes and scale-downs, and the instance running the parent no longer runs out of memory.

- **A child completion that never reached its parent is delivered by the parent.** A child persists `completed`/`failed` and then notifies its parent. A crash, scale-down or store error between the two left the parent's `running` placeholder and `child:<id>` waiter behind, and the parent's reconcile wake replayed straight back to the same wait, forever. Each turn of a run now reads the children it waits on (one batched read per 500, from its `running` placeholders, or from its `child:` waiters for a remote workflow) and settles the finished ones exactly as the notification would have. The notification itself retries a store error a few times, and a graceful shutdown waits for notifications in flight.
- **A step result whose resume was lost still resumes the run.** A redelivered result whose step had already settled was dropped, so a transport retry of a result whose resume failed, or whose instance went down after the write, left the run `suspended` on a finished step. It now resumes a `suspended` run (subject to a step fan's barrier). A resume that found the run leased by another instance looks again once that lease is free, so a holder that went down mid-turn costs one lease period. With `remoteRedispatchMs` set, a run waiting on a dispatched step parks no later than `reconcileMs` instead of on the redispatch deadline (an hour, say).
- **One instance never runs two turns of the same run side by side.** `execute` admits an instance into a lease it already holds, so wakes landing together each ran a whole turn: the last few hundred children of a fan settling at once replayed the parent hundreds of times concurrently, each with every checkpoint loaded. Wakes that arrive while a turn executes now share one more turn after it. A 5,000-child fan on a pooled store: 509 parent turns and a 1.86 GB heap peak before, 2 turns and 22 MB after.
- **`localRunConcurrency`** (engine and `DurableModule` option, default 256, `Infinity` for none) bounds the runs an instance executes in-process when it picks them up itself: the runs it starts, a fan's children included, and the runs other instances announce as enqueued (`engine.runEnqueued`, which the Nest timer poller now uses and which skips a run already taken). Child starts are queued under the same bound. The rest wait as run ids while the runs stay `pending` for any instance's poll. Before, a 40,000-child fan started and executed every child on the parent's instance at once.
- **`StateStore.getRuns(runIds)`** (optional): the existing runs among the ids, in one `IN (...)` read. Every bundled store implements it, `CodecStateStore` forwards it, and the shared store contract covers it. A replaying fan uses it instead of one `getRun` per child; without it the engine falls back to `getRun`, 50 at a time.
