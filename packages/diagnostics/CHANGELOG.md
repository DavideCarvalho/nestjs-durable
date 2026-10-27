# @dudousxd/nestjs-durable-diagnostics

## 0.1.2

### Patch Changes

- [#430](https://github.com/DavideCarvalho/nestjs-durable/pull/430) [`cccf750`](https://github.com/DavideCarvalho/nestjs-durable/commit/cccf7505aa92b7bd2519aef844c56c231921cc60) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Lifecycle events are recorded once across a deployment, by the instance that produced them. With a
  control plane every instance hears every event (that is what lets the dashboard live-tail a run from
  any pod), and the Telescope watcher, the core metrics, the OpenTelemetry spans and metrics and the
  diagnostics bridge each recorded every event they heard: once per pod. In a 12-pod deployment one
  40,000-step fan wrote 612,000 Telescope entries instead of about 80,000, and that write load saturated
  the database the run itself was using. The core now marks an event re-delivered from another instance
  (`isRemoteEvent(event)`), and those surfaces skip it. They read the mark by symbol, so an older core
  keeps working as before.

## 0.1.1

### Patch Changes

- 4559f11: Add NestJS 12 to the supported peer range

  NestJS 12 ships its core packages as pure ESM and requires Node >= 20.19. These packages are already
  `"type": "module"`, so nothing in the source had to change — but their `@nestjs/*` peer ranges topped
  out at `^11`, which is enough for a host app on 12 to get an unmet-peer warning or, on a strict
  installer, a refused install.

  `@nestjs/common` and `@nestjs/core` now accept `^10.0.0 || ^11.0.0 || ^12.0.0`, and
  `@nestjs/event-emitter` — whose own line jumped straight from 3.x to 12.x to track the framework —
  accepts `^2.0.0 || ^3.0.0 || ^12.0.0`. The dev dependencies moved to the 12.x line as well, so the
  suite that guards the module wiring, the lifecycle hooks and the in-app worker now runs against
  NestJS 12 rather than only claiming to support it.

## 0.1.0

### Minor Changes

- 1958ecf: Add `@dudousxd/nestjs-durable-diagnostics`: bridge WorkflowEngine lifecycle events onto the Aviary diagnostics bus (`aviary:durable:<type>`). Ships `attachDurableDiagnostics(engine)`, a global `DurableDiagnosticsModule`, and a typed `ChannelRegistry` augmentation so `@OnDiagnostic('durable', ...)` infers an `EngineEvent` payload.
