# @dudousxd/nestjs-durable-eslint-plugin

## 0.2.1

### Patch Changes

- b1dc075: fix: don't flag non-determinism inside a ctx.step / ctx.task callback

  A `ctx.step(...)` / `ctx.task(...)` body runs once and is checkpointed, so `new Date()` /
  `Math.random()` there is replay-safe — only the orchestration body must be deterministic. Both the
  ESLint rule (it now stops at a step/task callback boundary before reaching `run`) and the Biome
  GritQL plugin (`not within \`$_.step($...)\``) now exclude those, so a workflow that does its
  non-deterministic work inside steps lints clean.

## 0.2.0

### Minor Changes

- b24b915: feat: lint for non-determinism inside a @Workflow run (ESLint + Biome)

  A new package, `@dudousxd/nestjs-durable-eslint-plugin`, with a `no-nondeterminism` rule that flags
  `Date.now()` / `Math.random()` / `new Date()` / `crypto.randomUUID()` / `performance.now()` used
  inside a `@Workflow` `run` — they differ across replays and silently corrupt a durable run; use the
  checkpointed `ctx.now()` / `ctx.random()` / `ctx.uuid()`. The ESLint rule is AST-scoped to the
  workflow body; the package also ships a Biome (>= 2.0) GritQL plugin (`grit/no-nondeterminism.grit`)
  for Biome users, targeted at workflow files via `overrides`.
