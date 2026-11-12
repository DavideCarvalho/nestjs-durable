---
"@dudousxd/nestjs-durable-diagnostics": minor
---

New `@dudousxd/nestjs-durable-diagnostics/delivery` subpath: the durable transport behind `transports.durable()` in `@dudousxd/nestjs-diagnostics` 0.9. Every `(listener, event)` becomes a durable run with the id `diag:<event id>:<listener id>`, so a repeated delivery is a no-op. The run calls the listener in a retried step and shows up in the console under the `diagnostics` tag. Processes with diagnostics `role: 'api'` only start these runs; the other processes run them.

The bus bridge no longer forwards the lifecycle events of those delivery runs, so a listener on `durable` events doesn't trigger itself.
