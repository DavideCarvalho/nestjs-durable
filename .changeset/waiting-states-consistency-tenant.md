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
