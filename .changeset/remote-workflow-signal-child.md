---
'@dudousxd/nestjs-durable-core': minor
---

feat(engine): execute remote workflow `waitSignal` and `startChild` commands

The coordinator-driven (polyglot) engine now drives the last two workflow commands a remote worker
can emit. `ctx.wait_signal(name)` registers a signal waiter (resolved by `engine.signal(name, …)`,
with a buffered-before-wait signal re-driven safely after the turn suspends), and
`ctx.start_child(workflow, input)` starts a child run under a deterministic id and awaits it via the
existing parent-notify rendezvous — a failed child surfaces as a catchable `StepFailed` in the
parent's replay. Previously both threw "not supported yet". `call` / `recordStep` / `sleep` are
unchanged.
