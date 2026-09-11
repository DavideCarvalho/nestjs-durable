---
'@dudousxd/nestjs-durable': patch
---

Optional peers are actually optional — the package loads without `@dudousxd/durable-worker`

`@dudousxd/nestjs-durable` declares `@dudousxd/durable-worker` optional, then statically imported it
from three modules that the package entry re-exports. Anyone who took the declaration at its word —
an operator that owns the store and runs no worker at all — got `ERR_MODULE_NOT_FOUND` out of
`dist/index.js` before a line of their own code ran. Both the ESM and the CJS entry were affected.

**Every value from the worker SDK is now reached lazily**, through a single module, on the path that
needs it: `startRun` at the tenant client's `start`, `runRedisWorker` at bootstrap, and the
`DurableWorkerRuntime` in the provider factory that stands the runtime up — and that factory is
gated on the role, so an operator never reaches the import. A worker role configured without the
peer installed now fails with a message that names the package instead of a resolution error.

The runtime a pure thin worker registers on moved from the `DurableWorkerRuntime` class to a
`DURABLE_WORKER_RUNTIME` symbol token, because a class from an optional peer cannot be a DI token
without dragging the peer into the static import graph. It is exported; `moduleRef.get(...)` against
the class must become `moduleRef.get(DURABLE_WORKER_RUNTIME)`.

**`@Workflow({ inputSchema })` works in the ESM build.** `class-validator` and `class-transformer`
were loaded with `require()`, which esbuild leaves as a shim that throws in a real ESM process — so
the peers looked missing even when installed, and every ESM app registering an `inputSchema`
workflow died at boot telling you to install what it already had. They are loaded with `import()`
now, inside the validator.

`optional-peers.spec.ts` holds the line: it builds the package, installs the artifact into a temp
tree with each optional peer withheld in turn, and boots a real app against it.
