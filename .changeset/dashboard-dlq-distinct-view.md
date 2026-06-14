---
"@dudousxd/nestjs-durable-dashboard": minor
---

feat(dashboard): give dead-letter runs a distinct look

A dead-letter run is a recovery path, not the happy flow — so it now reads as one instead of
looking like a normal run. A `dlq:<id>` handler run shows a rose **DLQ** pill next to its title and
a prominent banner ("Dead-letter handler — started because run X was dead-lettered" + open-dead-run
button); a `dead` run that was routed to a handler shows the mirror banner ("Dead-lettered — routed
to a DLQ handler" + open-handler button). Dead-letter handler runs are also tagged **dlq** in the
runs list so they stand out among normal runs. Replaces the old single inline link.
