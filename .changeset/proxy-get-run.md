---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable": patch
---

`ProxyRunGateway` has `getRun`: a store-less pod reads a run without its timeline, through a new
`getRun` run request the control plane answers from its store, after the same tenant check as every
run-scoped verb. A caller that only needs a run's status no longer gets the whole run detail over the
wire (about 8 KB for a 33-step run, against 0.26 KB). A control plane that does not know the verb
answers with no data or an unsupported-request error, and the proxy then reads the run out of
`getRunDetail` and keeps doing so for a minute, the way `getFanMembers` falls back.
