---
"@dudousxd/nestjs-durable-eslint-plugin": minor
---

feat: lint for non-determinism inside a @Workflow run (ESLint + Biome)

A new package, `@dudousxd/nestjs-durable-eslint-plugin`, with a `no-nondeterminism` rule that flags
`Date.now()` / `Math.random()` / `new Date()` / `crypto.randomUUID()` / `performance.now()` used
inside a `@Workflow` `run` — they differ across replays and silently corrupt a durable run; use the
checkpointed `ctx.now()` / `ctx.random()` / `ctx.uuid()`. The ESLint rule is AST-scoped to the
workflow body; the package also ships a Biome (>= 2.0) GritQL plugin (`grit/no-nondeterminism.grit`)
for Biome users, targeted at workflow files via `overrides`.
