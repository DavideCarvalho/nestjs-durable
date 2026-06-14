---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-dashboard": minor
"@dudousxd/nestjs-durable-codegen": minor
---

feat: durable webhooks (`ctx.webhook()`)

A first-class, replay-safe "expose a callback URL and wait for it" primitive. `ctx.webhook()` mints
a deterministic token (`wh:<runId>:<seq>`) and — when the engine has a `webhookUrl` builder — a
public `url` to hand a third party inside a step; `await handle.wait()` then suspends with zero
compute until the callback arrives. The dashboard exposes `POST webhooks/:token` (turning the inbound
POST into `engine.signal`), the NestJS module gains a `webhookUrl` option, and the codegen extension
emits the `deliverWebhook` (and the previously-missing `continue`) route into the typed client.
