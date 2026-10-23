---
"@dudousxd/nestjs-durable-dashboard": patch
"@dudousxd/nestjs-durable-core": patch
---

Console ORIGIN facet: the row is now hidden unless at least one run has a named (package) origin, so a deployment where no run carries an origin no longer shows a useless `all N | unknown N`. Runs with no origin are labelled `app` (the app's own workflows) instead of `unknown`, with an updated tooltip, empty-state and run-header wording. The filter kind (`{ kind: 'unknown' }`) and the `?unattributed=true` param are unchanged.
