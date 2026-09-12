---
'@dudousxd/nestjs-durable-core': patch
---

Stop a remote `gather_calls` fan-out from orphaning its run for `reconcileMs`.

A remote workflow turn is dispatched SUSPEND-then-ENQUEUE: the engine marks
`awaitingDecisionTaskId`, releases the run lease, then enqueues; when the decision comes
back, `completeRemoteDecision` re-takes the lease to apply it. Meanwhile every settling
call runs `completeRemoteResult` → `resume` → `execute`, and `execute` gives up silently
when the lease is contended — no retry, no reschedule.

So in a fan-out the LAST call can settle while the decision computed WITHOUT it is being
applied. That call's wake is spent with nothing to show for it, and the stale decision then
parks the run on a `call` that is already complete. Every call is settled, nothing holds the
lease, no decision is awaited, and nothing is scheduled to wake it — the run sits `suspended`
until the `reconcileMs` orphan sweep re-drives it, five minutes later by default. A one-call
gather has no second settle to race, which is why only fan-outs stall.

Traced against a BullMQ + MySQL control plane driving a Python `durable-worker` over a
seven-call `ctx.gather_calls`, this stalled 23% of runs, with a bimodal latency of
"under a second, or exactly 300 s":

```
DISPATCH_TURN  historySeqs= 0/1/2/3/4/5      <- turn computed without seq 6
RESULT         seq= 6 completed              <- the last call settles
DECISION       continue                      <- decision from the older history
EXECUTE_DROP   lockedBy= undefined           <- seq 6's resume is dropped
PARK           cmds= call:6                  <- parked on an op already done
```

A turn that declares a blocking op whose checkpoint has already settled was, by definition,
computed from a history older than the store's — an up-to-date replay has that op in history
and skips it. The engine now detects exactly that and re-drives the run instead of parking it.
This is convergent rather than a retry: the re-driven turn sees the op resolved and cannot
re-declare it, so a lost wake costs one extra turn and never loops.
