---
'@dudousxd/nestjs-durable': patch
'@dudousxd/nestjs-durable-dashboard': patch
'@dudousxd/nestjs-durable-diagnostics': patch
'@dudousxd/nestjs-durable-telescope': patch
'@dudousxd/nestjs-durable-transport-event-emitter': patch
---

Add NestJS 12 to the supported peer range

NestJS 12 ships its core packages as pure ESM and requires Node >= 20.19. These packages are already
`"type": "module"`, so nothing in the source had to change — but their `@nestjs/*` peer ranges topped
out at `^11`, which is enough for a host app on 12 to get an unmet-peer warning or, on a strict
installer, a refused install.

`@nestjs/common` and `@nestjs/core` now accept `^10.0.0 || ^11.0.0 || ^12.0.0`, and
`@nestjs/event-emitter` — whose own line jumped straight from 3.x to 12.x to track the framework —
accepts `^2.0.0 || ^3.0.0 || ^12.0.0`. The dev dependencies moved to the 12.x line as well, so the
suite that guards the module wiring, the lifecycle hooks and the in-app worker now runs against
NestJS 12 rather than only claiming to support it.
