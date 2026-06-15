---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

Event-triggered workflows: a workflow can now **start** on a published event, not just wait for one.

- **Core**: `engine.register(name, version, fn, { onEvent: ['user.registered'] })` — `publishEvent(name, payload, { id })` now starts a fresh run of every subscribed workflow (payload becomes the input) in addition to resuming `waitForEvent` waiters. Idempotent by `evt:<id>:<workflow>`; the return count includes both resumed and started runs.
- **NestJS**: `@Workflow({ onEvent: [...] })` **or** a dedicated `@OnEvent('a', 'b')` class decorator (listen to several events; both forms merge). `workflowService.publishEvent(name, payload, { id })` gained the dedup id.
