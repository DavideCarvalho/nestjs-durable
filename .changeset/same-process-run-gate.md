---
'@dudousxd/nestjs-durable-core': patch
---

A run no longer executes twice at once in one process. The run lease is keyed by engine instance, and `execute()` skipped `tryLockRun` when its snapshot said this instance already held the lease, so a resume landing while this same process was still executing the run (a signal, a late step result, a child wake, an explicit `resume()`) ran the body concurrently and a step whose checkpoint was not written yet ran twice. Resumes of a run are now serialized in-process: one landing mid-execution is queued and re-drives the run once that execution has settled and released its lease (resumes queued meanwhile coalesce into it), so the wake is neither doubled nor lost. A run that calls `engine.resume()` on itself from inside its own execution gets the current status back instead of recursing. Across processes the lease still decides, unchanged.
