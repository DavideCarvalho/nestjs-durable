---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-testing": patch
---

An explicit `resume()` of a `failed` run whose lease is still held (the turn that failed it has not released it yet, or another instance holds it) now waits for the lease and re-drives the run, instead of returning `failed` and dropping the retry. A lease that expires is taken over with the usual fenced take. If a live execution keeps the lease for longer than one lease period, `resume()` rejects with an error instead of silently doing nothing. The store contract suite covers the case.
