---
'@dudousxd/nestjs-durable-core': patch
---

`requeue` now re-runs the failed step of a run whose turns are dispatched to a workflow worker. The history the engine sends a dispatched turn leaves out the step failure `requeue` reset, so the worker's replay runs the step again instead of throwing the stored error, and a re-emitted `call` is dispatched as a fresh first attempt. Inline and dispatched runs now redrive the same way, including a step with no retry policy, a `localStep`, and a failed child reached through its parent. A dispatched run that was requeued before this upgrade, caught the step's failure and is still live can see that step dispatched once more after the upgrade.
