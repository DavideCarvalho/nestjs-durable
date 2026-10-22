---
'@dudousxd/nestjs-durable-core': minor
---

A run's step results are settled in batches. The results of one run that arrive while a batch is being written go into the next one, up to 256. A batch claims its checkpoints with one call to the new optional `StateStore.saveCheckpointsIfPending`, checks a step fan's join barrier once, and resumes the run at most once. With `resultConcurrency: 64`, a 5,000-step fan on SQLite drops from 4 SQL statements and one commit per result to about 2 statements and 1/64 of a commit.

What stays the same: each step settles exactly once (a duplicate delivery, in the same batch or a later one, is dropped by the compare-and-set), the parent wakes once per settled wave, a failure still wakes it, and a result is acknowledged only after the write holding it commits. If the batched write rejects, the engine writes the batch's rows one by one, so one bad row fails only its own result. A barrier count that fails now resumes the run rather than failing the result. With `resultConcurrency: 1` (the default) every batch holds one result, which is the same path as before.

`CodecStateStore` forwards `saveCheckpointsIfPending`, encoding every entry, when the store it wraps has it. The in-memory store implements it.
