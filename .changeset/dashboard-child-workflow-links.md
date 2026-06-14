---
"@dudousxd/nestjs-durable-dashboard": minor
---

feat(dashboard): child-workflow nodes link to their child run

Child workflows are now first-class in the run view. A step that ran another workflow —
`ctx.child` (awaited) or `ctx.startChild` (fire-and-forget) — is rendered with a distinct
child glyph and an indigo "child ↗" marker in both the graph and the spans timeline.
Clicking it opens the child's run, so you can walk parent → child the same way the
dead-letter link walks dead → handler. Detection is by checkpoint name (`spawn:<id>` /
`signal:child:<id>`), so no API/wire change is needed.
