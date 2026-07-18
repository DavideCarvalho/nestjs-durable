---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

Make the `RunGateway` DI token idiomatic. `RunGateway` (in `-core`) is now an **abstract class** that doubles as its own NestJS injection token, so providers bind `{ provide: RunGateway, useFactory/useClass }` and consumers inject `constructor(private readonly gateway: RunGateway)` — no string/symbol token. Because `-core` is a required peer of both `nestjs-durable` and its dashboard, the single abstract class is a shared token across packages, replacing the previous duplicated `Symbol.for('nestjs-durable:run-gateway')` value-sharing hack.

Non-breaking: the `RUN_GATEWAY` symbol export is kept as a `@deprecated` alias pointing at the `RunGateway` class, so existing `@Inject(RUN_GATEWAY)` / `{ provide: RUN_GATEWAY }` sites resolve the very same token. It will be removed in a future major.
