---
'@dudousxd/nestjs-durable': minor
---

Rename `@OnEvent` to `@OnDurableEvent` — the old name clashes with `@nestjs/event-emitter`'s `@OnEvent`, and in an app using both libraries an auto-import picking the wrong decorator fails silently in either direction. `OnEvent` remains exported as a deprecated alias and will be removed in the next minor.
