---
'@dudousxd/nestjs-durable-core': patch
---

Fix: a singleton run handed a freed slot could be left suspended with no wake time and never resume

When a singleton run settles, notify-on-release hands the freed slot to the oldest gated waiter. That
handover cleared the waiter's durable `wakeAt` and then dispatched it — but `dispatch` goes through
the configured `runDispatcher`, which is legitimately a NO-OP on an instance that must not run
workflows (an API or dashboard pod), while that same instance still observes settles and so still runs
the wake. The waiter was then left `suspended` with no wake time: invisible to `listPendingRuns`,
`listIncompleteRuns` and `listDueTimers` alike, and unreachable forever. Every run behind it correctly
refused admission, so one orphan wedged its whole singleton key until the `executionTimeout` reaper
cancelled the queue. Observed in production.

The handover now stamps a due-NOW `wakeAt` instead of clearing it, so the timer poller is a guaranteed
pickup regardless of what the dispatcher does — and a gated run that somehow carried no `wakeAt` gets
one. A dispatch + timer double-drive is safe: the run lock admits one executor and the loser's pickup
is a cheap no-op. Ports the fix already carried by the AdonisJS port of this engine.
