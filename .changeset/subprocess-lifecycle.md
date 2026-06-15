---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

Extensible sub-process model: `StepEvent` gains optional `subId` (run identity), `group`, and `phase`
fields, and `StepLogger` gains `subEvent()` for emitting per-sub-process phase transitions and a
terminal outcome. The dashboard renders each sub-process as an expandable lifecycle row (phases,
duration, status, error, owned logs) grouped by run identity. The existing `sub(name, status)` is
unchanged.
