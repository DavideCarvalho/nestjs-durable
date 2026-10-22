---
'@dudousxd/nestjs-durable-core': patch
---

A lease release that fails no longer escapes the end of a turn. The `finally` that ends a turn releases the run's lease on the failure path too, where the thing that failed the run is often the same store the release talks to (a step that violated a DB constraint leaves Postgres refusing every further statement on that connection). The release then threw out of the `finally`: the caller of `resume()`/`signal()` got the lease error instead of the run's outcome, the post-turn re-drives of already-settled children and steps were skipped, and a turn driven as a background resume surfaced it as an unhandled rejection. The release is now best effort and logs a warning; the lease expires on its own and recovery re-drives whatever is still held. The remote-workflow paths that release after settling (cancel finalize, onError handoff, timeout) do the same.
