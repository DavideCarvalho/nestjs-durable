---
'@dudousxd/nestjs-durable-core': patch
---

Classify each worker-health group as `'workflow'` or `'step'` on `GroupHealth.kind`. Route-by-handler gives every `@Workflow` and `@Step` its own queue, so a health list mixes both — `workerHealth()` now labels each from the engine's authoritative registry (a group whose base token is a registered workflow name, or a registered remote workflow's group, is a workflow; anything else — an in-process step, a remote `handle_*` — is a step). No name heuristics, no worker/transport/Python changes: the control plane already knows. Lets a dashboard summarise the fleet in domain terms ("N workflows · M steps") instead of leaking the raw queue count. `kind` is optional and only set where a control-plane registry was available to classify.
