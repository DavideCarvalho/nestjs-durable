---
'@dudousxd/nestjs-durable-eslint-plugin': patch
---

Fix the `no-nondeterminism` Biome GritQL plugin over-matching co-located `@Step`/`@DeadLetter` methods. The rule flagged `new Date()`/`Math.random()`/etc. anywhere in a workflow file, so an `@Step` method (which runs once on a worker and is checkpointed — off the replay path) that legitimately reads wall-clock time tripped a false positive, and the rule's own `ctx.now()` advice doesn't even apply there (a step has no `ctx`). The query is now scoped to `within \`run($...) { $... }\`` — only the replayed orchestration body — matching the ESLint rule's behavior. The stale `ctx.step(...)` exclusion is replaced with `ctx.sideEffect(...)` (the current checkpointed escape hatch; `ctx.step` no longer wraps a closure), so a non-deterministic call passed directly to `ctx.step(...)` in the run body is still flagged.
