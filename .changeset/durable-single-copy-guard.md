---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
---

Fail at boot when two copies of `@dudousxd/nestjs-durable-core` are loaded in one process (for example two pnpm peer-resolution variants). `DurableModule.forRoot` / `forRootAsync` throw a `DuplicateDurableCopyError` naming both installs and the fix (same peer versions in the app and its workspace packages, or pnpm overrides), instead of failing later because each copy has its own `WorkflowEngine` class. A distinct copy that loads after boot throws on load. `@dudousxd/nestjs-durable` now needs `@dudousxd/nestjs-durable-core` 0.93.0 or later.
