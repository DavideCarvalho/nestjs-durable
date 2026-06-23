---
"@dudousxd/nestjs-durable-core": patch
---

Fix remote workflow resurrection when cancelled mid-turn. In `runRemoteExecution`, a `continue`/`suspended` decision from the executor could overwrite a `cancelled` status already written by a parent cancel cascade, causing recovery to re-drive the run forever. The fix re-reads the run from the store before calling `settleRun` and bails if the run is already cancelled/terminal — identical to the guard already present in `completeRemoteResult` for remote step results.
