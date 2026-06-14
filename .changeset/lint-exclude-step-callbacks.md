---
"@dudousxd/nestjs-durable-eslint-plugin": patch
---

fix: don't flag non-determinism inside a ctx.step / ctx.task callback

A `ctx.step(...)` / `ctx.task(...)` body runs once and is checkpointed, so `new Date()` /
`Math.random()` there is replay-safe — only the orchestration body must be deterministic. Both the
ESLint rule (it now stops at a step/task callback boundary before reaching `run`) and the Biome
GritQL plugin (`not within \`$_.step($...)\``) now exclude those, so a workflow that does its
non-deterministic work inside steps lints clean.
