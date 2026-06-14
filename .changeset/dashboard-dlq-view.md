---
"@dudousxd/nestjs-durable-dashboard": patch
---

feat(dashboard): link the two ends of a dead-letter relationship

A run's detail now shows the DLQ relationship both ways: a `dead` run that was routed to a
`dlq:<id>` handler links forward to it (probed so the link only shows when the handler exists), and a
`dlq:<id>` handler run links back to the dead run it's handling. Makes the "normal path failed → went
to the DLQ" flow navigable instead of two disconnected runs.
