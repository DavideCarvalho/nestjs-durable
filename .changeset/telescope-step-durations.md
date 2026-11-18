---
"@dudousxd/nestjs-durable-telescope": minor
---

Telescope's "Slowest jobs" card can rank workflow steps.

- A step's outcome (`step.completed` / `step.failed`) is recorded with its measured duration as the entry's `durationMs` and with `durable:step:<step name>` as its family (the same for both outcomes; a name past the 64-character `family_hash` column is cut and suffixed with a short hash). A failed step is tagged `failed`. Sleeps and signal waits get no family. Run families are unchanged.
- On a control plane, the watcher names `durable` among the watchers Telescope runs for its tenants, so the console counts it on for every app in view (`@dudousxd/nestjs-telescope` 5.15.0+; older versions ignore it).
