---
"@dudousxd/nestjs-durable-telescope": patch
---

Fix: the durable Telescope watcher no longer crashes registration on a store-less thin-worker /
tenant deployment. In that topology the `WorkflowEngine` token resolves to a start-only
`DurableStartClient` facade (it proxies run starts over the transport and has no local lifecycle
event stream — those events live on the operator that holds the store), so calling `engine.subscribe`
threw `engine.subscribe is not a function` and the watcher failed to register. The watcher now skips
registration gracefully when the resolved engine exposes no `subscribe`, leaving the rest of
Telescope unaffected.
