---
'@dudousxd/nestjs-durable-core': patch
---

Step events reach other instances in batches. The engine published every lifecycle event on the
control plane, one message each, and a wide fan emits two per step: a 40,000-step fan published 80,000
messages, each delivered to every pod. In flip dev each Redis `PUBLISH` of them took 10–53 ms (slowlog)
and stalled every other command behind it. Step events now go out, in emit order, in one
`{ kind: 'events', events }` message per batch (the events emitted while a publish is in flight share
the next one, up to 500): 40,000 → ~600 publishes for a 20,000-step fan. A run's own events still go
out one per message. An instance that does not know the `events` kind ignores it (the Python worker
reads only `cancel`), and only misses other instances' step events, which no engine logic reads.
