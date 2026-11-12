---
"@dudousxd/nestjs-durable-admission-redis": minor
"@dudousxd/nestjs-durable-cli": minor
"@dudousxd/nestjs-durable-codegen": minor
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-dashboard": minor
"@dudousxd/nestjs-durable-diagnostics": minor
"@dudousxd/nestjs-durable-eslint-plugin": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-otel": minor
"@dudousxd/nestjs-durable-store-drizzle": minor
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable-store-prisma": minor
"@dudousxd/nestjs-durable-store-typeorm": minor
"@dudousxd/nestjs-durable-telescope": minor
"@dudousxd/nestjs-durable-testing": minor
"@dudousxd/nestjs-durable-transport-bullmq": minor
"@dudousxd/nestjs-durable-transport-db": minor
"@dudousxd/nestjs-durable-transport-event-emitter": minor
"@dudousxd/nestjs-durable-transport-sqs": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable-workflows-gateway": minor
"@dudousxd/nestjs-durable-workflows-remote": minor
---

Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`, `>=22`, or unset). CI tests on Node 24 and 26, and builds and releases on Node 24. Upgrade Node, then the packages.

Removed, with no alias (see the docs' Upgrading page):

- `@dudousxd/nestjs-durable-core`: `RunSchedulesOptions.sleep`, which was no longer called, and the `InternalWorkflowCtx` type (use `WorkflowCtx`).
- `@dudousxd/nestjs-durable`: `@DurableStep` (use `@Step`), `@OnEvent` (use `@OnDurableEvent`), and `@Workflow({ inputSchema })` (use `input`).
- `@dudousxd/nestjs-durable-dashboard`: `RUN_GATEWAY`.

Still exported, deprecated, because published releases of sibling packages import them: `RUN_GATEWAY` from `@dudousxd/nestjs-durable` (it is the `RunGateway` class), and `STATE_STORE`, `TRANSPORT` and `DURABLE_OPTIONS` from `@dudousxd/nestjs-durable-core` (`DurableModule` binds them to the same instances as the `*_CANONICAL` tokens). New code should inject `RunGateway` and the `*_CANONICAL` tokens.

Fixed: the dual ESM/CJS packages could publish without `index.d.cts`. Their ESM and CJS tsup builds run in parallel, and the cleaning one's declaration step deleted the other's output. `dist` is now cleaned once, before both builds. `@dudousxd/nestjs-durable-eslint-plugin` exports `meta` as a named export too, so an ESM `import durable from …` of the CommonJS plugin carries it.
