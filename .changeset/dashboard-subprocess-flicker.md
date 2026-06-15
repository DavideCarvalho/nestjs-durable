---
'@dudousxd/nestjs-durable-dashboard': patch
---

fix(dashboard): stop sub-processes flickering on in-flight runs

The 1.5s poll (and lifecycle invalidations) refetched a still-running step with empty `events` — the
store only persists a step's events at completion — and React Query replaced the cache, wiping the
trail the live `step.progress` stream had appended. Sub-processes appeared, vanished, then reappeared
on the next stream event. The run query now merges over the cache (`mergeLiveEvents`): an in-flight
step keeps its streamed events, while a completed/failed step's fetched events stay authoritative.
