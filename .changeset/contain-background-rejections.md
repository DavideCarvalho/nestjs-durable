---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable": patch
"@dudousxd/nestjs-durable-admission-redis": patch
---

Prevent handled workflow turn failures from creating an unhandled tracking rejection. Reject and clean up waitForRun when its store lookup fails, and contain background tenant-event lookup and initial Redis liveness failures so temporary storage errors do not terminate the worker.
