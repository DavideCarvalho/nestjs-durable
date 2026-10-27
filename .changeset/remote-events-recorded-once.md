---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-telescope": patch
"@dudousxd/nestjs-durable-otel": patch
"@dudousxd/nestjs-durable-diagnostics": patch
---

Lifecycle events are recorded once across a deployment, by the instance that produced them. With a
control plane every instance hears every event (that is what lets the dashboard live-tail a run from
any pod), and the Telescope watcher, the core metrics, the OpenTelemetry spans and metrics and the
diagnostics bridge each recorded every event they heard: once per pod. In a 12-pod deployment one
40,000-step fan wrote 612,000 Telescope entries instead of about 80,000, and that write load saturated
the database the run itself was using. The core now marks an event re-delivered from another instance
(`isRemoteEvent(event)`), and those surfaces skip it. They read the mark by symbol, so an older core
keeps working as before.
