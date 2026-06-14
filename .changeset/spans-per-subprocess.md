---
"@dudousxd/nestjs-durable-dashboard": minor
---

feat(dashboard): per-sub-process spans in the timeline waterfall

A step that fans out into sub-processes (e.g. parallel p-processes recorded via the step logger) now
expands into a mini-waterfall under its bar — one sub-bar per sub-process, placed across the step's
own window and colored by outcome (ok / failed / skipped) — instead of a single opaque bar. Steps
with no sub-processes render exactly as before.
