---
"@dudousxd/nestjs-durable-dashboard": patch
---

Ship the dashboard server build as dual ESM + CJS (was ESM-only), matching every other package in
the ecosystem.

The server entry was compiled with `tsc` to ESM only, and `package.json#exports` exposed just an
`import` condition. A CommonJS host (e.g. a NestJS app built with `nest build` → CommonJS) that
`require`s this package would load the ESM build, while it `require`s `@dudousxd/nestjs-durable` as
CJS. ESM and CJS are separate module instances, so the dashboard pulled a SECOND copy of
`@dudousxd/nestjs-durable-core`. The DI symbol tokens survive that split (they're `Symbol.for`), but
`WorkflowEngine` — a class used as an injection token — does not: each core copy exposes a distinct
class object, so `DashboardService`'s `WorkflowEngine` (and `STATE_STORE`) no longer matched the
providers exported by `DurableModule`, and boot failed with `Nest can't resolve dependencies of the
DashboardService (?, WorkflowEngine) ... in the DurableApiModule module`. App-internal test runners
(Vitest/swc) load everything as one module system, so this only surfaced in built CJS apps.

The server now builds through the shared decorator-aware tsup config (dual format, SWC so DI
metadata survives), `import.meta.url` is shimmed in the CJS output (the UI controller uses it to
locate the bundled SPA), and `exports["."]` gains a `require` condition. A CJS host now resolves the
dashboard — and therefore core — in the same module system as the rest of the durable packages, so
they share one `WorkflowEngine`. No API change. The `./client` (browser) entry stays ESM.
