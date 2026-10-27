---
"@dudousxd/nestjs-durable-telescope": patch
---

A run's trace and root-span ids are hashed once per run instead of on every lifecycle event. A wide
step fan emits tens of thousands of events for the same run, and each one hashed the run id up to
four times (two sha256 digests per call). The ids of the last 512 runs are kept; they are still a
pure function of the run id, so a run whose ids were evicted hashes back to the same ones.
