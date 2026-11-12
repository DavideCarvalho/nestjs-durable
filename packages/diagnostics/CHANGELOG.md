# @dudousxd/nestjs-durable-diagnostics

## 0.2.0

### Minor Changes

- [#453](https://github.com/DavideCarvalho/nestjs-durable/pull/453) [`c5e29dc`](https://github.com/DavideCarvalho/nestjs-durable/commit/c5e29dc890c92b7f2d5273054e886c3848909745) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New `@dudousxd/nestjs-durable-diagnostics/delivery` subpath: the durable transport behind `transports.durable()` in `@dudousxd/nestjs-diagnostics` 0.9. Every `(listener, event)` becomes a durable run with the id `diag:<event id>:<listener id>`, so a repeated delivery is a no-op. The run calls the listener in a retried step and shows up in the console under the `diagnostics` tag. Processes with diagnostics `role: 'api'` only start these runs; the other processes run them.

  The bus bridge no longer forwards the lifecycle events of those delivery runs, so a listener on `durable` events doesn't trigger itself.

## 0.1.3

### Patch Changes

- [#445](https://github.com/DavideCarvalho/nestjs-durable/pull/445) [`582efc7`](https://github.com/DavideCarvalho/nestjs-durable/commit/582efc7b154807f23d53e55f18bd766ce0c28fc1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Widen peer ranges so apps on the current releases install without peer conflicts: `@dudousxd/nestjs-durable` accepts `@dudousxd/nestjs-context` 1.x (`>=0.1.0 <2.0.0`), `@dudousxd/nestjs-durable-telescope` accepts `@dudousxd/nestjs-telescope` 2.x (`>=1.0.0 <3.0.0`), and `@dudousxd/nestjs-durable-diagnostics` accepts `@dudousxd/nestjs-diagnostics` 0.3 to 0.8 and later 0.x (`>=0.3.0 <1.0.0`, previously `^0.3.0`). No code changes: the APIs these packages use are unchanged in context 1.1.0, telescope 2.0 and diagnostics 0.8.0.

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
