---
"@dudousxd/nestjs-durable-core": patch
---

Define the DI tokens (`STATE_STORE`, `TRANSPORT`, `DURABLE_OPTIONS`) with `Symbol.for(...)` (global
symbol registry) instead of plain `Symbol(...)`.

A process can hold more than one physical copy of `core` at runtime — pnpm peer-dependency
multiplexing installs a separate virtual copy per distinct peer set, and the dual ESM/CJS build can
be evaluated once as `import` (`index.js`) and once as `require` (`index.cjs`). Plain `Symbol()`
mints a distinct token per copy, so `DurableModule` (which provides the tokens) and an injector in
another package — `DashboardService` in `@dudousxd/nestjs-durable-dashboard`, or a store adapter —
could resolve different symbol instances. Nest then can't satisfy the dependency and boot fails with
`Nest can't resolve dependencies of the DashboardService (?, WorkflowEngine) ... Symbol(nestjs-durable:STATE_STORE) ... is available in the DurableApiModule module`.
A registered symbol collapses every copy to one identity, mirroring the existing `CONTEXT_ACCESSOR`
token. No API change.
