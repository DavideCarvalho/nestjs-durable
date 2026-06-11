# nestjs-durable

Durable workflows for NestJS, with steps that can run across apps and languages.

Write a workflow as plain code. The engine checkpoints every step, so the flow survives
crashes and deploys and resumes exactly where it stopped. Some steps run locally in NestJS;
others run on a remote worker (Python first) — but it is **one workflow**, with **one source
of truth**, and **one end-to-end view**.

## Why

Today multi-service flows are scattered: a queue here, a queue there, a piece in Python, and
no single place to read or watch the whole flow. `nestjs-durable` collapses that into:

1. **The flow becomes code, in one place.** Read the workflow function, understand the whole
   sequence — even when steps execute in different apps.
2. **Durability.** Survives crash/deploy without re-running completed steps.
3. **End-to-end visibility.** Because one orchestrator owns the state, it knows about *every*
   step (including the Python ones), so a full-flow trace and dashboard come almost for free.

## Status

Early design + scaffold. See [`docs/plans`](docs/plans/2026-06-11-nestjs-durable-design.md)
for the full design.

## Packages (planned)

| Package | Role |
| --- | --- |
| `@dudousxd/nestjs-durable-core` | Interfaces, engine, deterministic replay, decorators |
| `@dudousxd/nestjs-durable` | NestJS module, discovery, `WorkflowCtx`, boot recovery |
| `@dudousxd/nestjs-durable-transport-event-emitter` | In-process Transport via `@nestjs/event-emitter` (zero-infra default) |
| `@dudousxd/nestjs-durable-transport-bullmq` | Queue adapter for cross-process / cross-language steps |
| `@dudousxd/nestjs-durable-store` | `StateStore` interface + `InMemoryStore` |
| `@dudousxd/nestjs-durable-store-{prisma,typeorm,drizzle,mikro-orm}` | ORM adapters |
| `@dudousxd/nestjs-durable-otel` | OpenTelemetry instrumentation |
| `@dudousxd/nestjs-durable-dashboard` | Embedded run/timeline UI |
| `@dudousxd/nestjs-durable-testing` | Fakes, crash injection, replay assertions |
| `durable-worker` (PyPI) | Remote worker SDK |

## License

MIT
