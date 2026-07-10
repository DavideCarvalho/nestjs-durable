---
'@dudousxd/nestjs-durable-dashboard': patch
---

Follow-ups to the legible waiting-run states:

- **List ↔ detail now agree.** The detail header derived its status from the timeline alone, so a run
  that had settled a step and was waiting for its workflow worker to advance showed `awaiting` in the
  detail while the list correctly showed `no-worker`. Both now use the same health-aware
  `deriveRunState` (the detail just also passes the `timeline` for step-level precision — an in-flight
  step reads `running` when its group has a worker, `no-worker` when it doesn't; a pending signal
  checkpoint reads `awaiting` named the same way as the list; a pending sleep reads `sleeping`). The
  graph's end node takes the same resolved status.
- **Tenant shown.** A run's worker-pool partition (`namespace`) is shown as a chip in the list row and
  the detail header when it's a real named tenant (hidden for the single-pool `default`).
- **English copy.** The no-worker banner and the singleton-queued label are in English
  ("Runs waiting on handlers with no live worker…", "behind leader …").
- **No-worker is now gated on real queue backlog, not bare `liveWorkers === 0`.** A worker only
  heartbeats for a group while it's serving it, so an IDLE group (a suspended run parked on its
  reconcile timer with nothing enqueued; a scheduled workflow between cron runs) legitimately reports
  zero live workers — and the old check mislabelled those runs "no-worker" even though their steps
  were all complete and nothing was blocked. `deriveRunState` now flags `no-worker` only when a
  group is STALLED — `depth > 0 && liveWorkers === 0`, a backlog with no consumer (the alert
  condition `GroupHealth` itself documents). A parked/settled run with no backlog reads `running`
  (open, in flight) and flips to `no-worker` only once its resume actually enqueues with no consumer.
  This also corrects the header banner, which was counting completed-work orphans as stalled.
