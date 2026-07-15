---
'@dudousxd/nestjs-durable': patch
---

`TRANSPORT_CANONICAL` now falls back to the pool's primary (`transports[0].transport`) when only
`transports` (plural) is configured. Previously it resolved strictly from the singular `transport`
option, so a pool-configured operator (e.g. the tenant-scoped control plane pairing a namespaced
primary with a bare-prefix secondary) injected `null` into the step registrar and in-app worker —
NO step handlers were registered on that pod, and its own steps parked in `wait` with no consumer
(no heartbeats, no errors). Single-`transport` setups are unchanged.
