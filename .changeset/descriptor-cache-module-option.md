---
'@dudousxd/nestjs-durable': patch
---

`DurableModule.forRoot({ workerDescriptorCacheMs })` passes the engine's descriptor-read cache window through (default 2000 ms; `0` reads on every dispatch). It was only settable on `WorkflowEngine`.
