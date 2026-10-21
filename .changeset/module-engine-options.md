---
'@dudousxd/nestjs-durable': patch
---

`DurableModule.forRoot` / `forRootAsync` now forward `timerBatchSize`, `reconcileMs`, `eventBufferTtlMs`, `blockedPollMs` and `trackStepStart` to the `WorkflowEngine`. Before, those options could only be set on a hand-built engine, so module users always got the defaults (for example a timer batch of 500).
