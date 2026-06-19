# `@dudousxd/nestjs-durable-diagnostics` — Design Spec

**Date:** 2026-06-19
**Status:** Approved (design), pending implementation plan
**Repo:** `nestjs-durable` (new `packages/diagnostics` package)

## Goal

Bridge `nestjs-durable`'s engine lifecycle events onto the Aviary diagnostics bus
(`@dudousxd/nestjs-diagnostics`) so that every workflow/step transition is observable on the
**`aviary:durable:<type>`** channels — exactly like resilience/authz/context/inertia already are.
Once durable emits over diagnostics, a single `@OnDiagnostic('durable', 'run.failed')` handler (the
decorator just shipped in nestjs-diagnostics) — or any `getChannel('durable', …).subscribe(...)`,
or the diagnostics-telescope watcher — reacts to durable events with **zero extra dependencies**.
This is roadmap item #2 of "diagnostics as the unified ecosystem event bus": durable first,
notifications next.

Durable keeps its existing OTel and Telescope integrations untouched — this is **additive**. The
engine's own event bus (`WorkflowEngine.subscribe`) stays the single source; we add one more
subscriber that re-emits over diagnostics.

## Background & constraints

- **Event source — `WorkflowEngine.subscribe(listener): () => void`** (`packages/core/src/engine.ts:528`).
  The listener receives an `EngineEvent` and the call returns an unsubscribe function. This is the
  same bus the OTel bridge (`attachDurableOtel`) and the Telescope watcher already subscribe to. A
  throwing subscriber is isolated by the engine ("a misbehaving subscriber must never break workflow
  execution", `engine.ts:620`).
- **Event shape — `EngineEvent`** (`packages/core/src/interfaces.ts:919`):
  ```ts
  interface EngineEvent {
    type: EngineEventType;
    runId: string;
    workflow?: string;
    seq?: number;
    name?: string;
    kind?: StepKind;
    output?: unknown;
    error?: StepError;
    durationMs?: number;
    queueMs?: number;
    event?: StepEvent;   // only on step.progress
    at: Date;
  }
  type EngineEventType =
    | 'run.started' | 'run.completed' | 'run.failed' | 'run.suspended'
    | 'step.started' | 'step.completed' | 'step.failed' | 'step.progress';
  ```
- **Diagnostics emit — `emit(lib, event, payload, opts?)`** (`@dudousxd/nestjs-diagnostics`,
  `channel.ts:97`). Publishes a `DiagnosticEvent { v, ts, lib, event, traceId?, payload }` on
  `aviary:<lib>:<event>`. It is **zero-cost when no one is subscribed** (`if (!channel.hasSubscribers)
  return;` before any allocation) and **never throws** (the whole body is `try/catch`). Arbitrary
  `lib`/`event` strings are accepted (`LibOf`/`EventOf` are `… | LooseString`); a `ChannelRegistry`
  declaration-merge upgrades a pair to a typed payload.
- **Build:** durable packages use **tsup** (dual ESM + CJS), `moduleResolution: Bundler`,
  extensionless imports — **mirror `packages/otel` exactly**, NOT diagnostics' tsc/NodeNext. The
  package uses no decorators (esbuild-safe), same as otel.
- **`WorkflowEngine` is a DI provider** exported by `DurableModule` (`durable.module.ts:294`). The
  Telescope watcher resolves it with `ctx.moduleRef.get(WorkflowEngine, { strict: false })` — the
  same trick the Nest module here uses.

**Reference implementations:**
- `packages/otel/src/durable-otel.ts` — the `engine.subscribe((event) => switch(event.type){…})`
  shape, returning the unsubscribe function. The diagnostics bridge is the same skeleton with a
  single `emit(...)` body instead of span bookkeeping.
- `packages/telescope/src/durable-telescope.watcher.ts` — resolving `WorkflowEngine` from
  `moduleRef` and subscribing at registration; the model for the Nest module's bootstrap attach.
- `packages/otel/{package.json,tsup.config.ts,tsconfig.json}` — the exact build/packaging template
  to copy.

## Decision: package shape

A **new standalone package `@dudousxd/nestjs-durable-diagnostics`** (`packages/diagnostics`),
mirroring `@dudousxd/nestjs-durable-otel`. Two surfaces, so both the manual (otel-style) and the
DI-friendly (import-and-forget) paths work:

1. **`attachDurableDiagnostics(engine)`** — the primitive. One `engine.subscribe` that re-emits every
   event verbatim over diagnostics. Returns the unsubscribe function. (Mirrors `attachDurableOtel`.)
2. **`DurableDiagnosticsModule`** — a global Nest module that resolves `WorkflowEngine` on bootstrap
   and calls `attachDurableDiagnostics`, unsubscribing on shutdown. Import it once and durable is on
   the bus.
3. **Optional `ChannelRegistry` augmentation** — a side-effect types file that declares
   `durable`'s eight channels with `EngineEvent` payloads, so `@OnDiagnostic('durable', 'run.failed')`
   and `getChannel('durable', 'run.failed')` get a typed `payload: EngineEvent`.

`@dudousxd/nestjs-diagnostics` and `@dudousxd/nestjs-durable-core` are **peer dependencies**;
`@nestjs/common` + `@nestjs/core` are **optional peers** (only the module needs them — the
`attach*` function is framework-free).

## File structure

```
packages/diagnostics/
├── package.json            # mirrors packages/otel/package.json
├── tsup.config.ts          # identical to packages/otel/tsup.config.ts (dual ESM+CJS)
├── tsconfig.json           # identical to packages/otel/tsconfig.json
├── README.md
└── src/
    ├── index.ts                       # export * from attach + module; export the registry augmentation
    ├── attach-durable-diagnostics.ts  # attachDurableDiagnostics(engine)
    ├── attach-durable-diagnostics.spec.ts
    ├── durable-diagnostics.module.ts  # DurableDiagnosticsModule
    ├── durable-diagnostics.module.spec.ts
    └── channel-registry.ts            # ChannelRegistry declaration-merge (typed payloads)
```

Plus a changeset under `.changeset/` (minor; new package).

## Component 1 — `attachDurableDiagnostics(engine)`

```ts
import { type EngineEvent, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { emit } from '@dudousxd/nestjs-diagnostics';

/**
 * Re-emit every engine lifecycle event onto the Aviary diagnostics bus as
 * `aviary:durable:<type>` (e.g. `aviary:durable:run.failed`). The whole `EngineEvent` is the
 * payload. Zero-cost per event while no diagnostics subscriber is attached (emit short-circuits on
 * `hasSubscribers`), and emit never throws back into the engine. Returns an unsubscribe function.
 */
export function attachDurableDiagnostics(engine: WorkflowEngine): () => void {
  return engine.subscribe((event: EngineEvent) => {
    emit('durable', event.type, event);
  });
}
```

- **All eight `EngineEventType`s are forwarded verbatim** — including the high-frequency
  `step.progress` and `step.started`. The diagnostics layer is the filter: a consumer subscribes only
  to the channels it wants, and unsubscribed channels cost nothing. The bridge stays dumb (no
  per-type logic, unlike otel which only spans a subset).
- **Channel names keep the dotted event type:** `aviary:durable:run.started`,
  `aviary:durable:step.completed`, etc. `channelName('durable', 'run.started')` →
  `aviary:durable:run.started`. Dots in the event segment are valid `diagnostics_channel` names and
  keep the names identical to durable's own `EngineEventType` strings (no translation layer to drift).
- **No `traceId` is set** in v1 — durable events carry no top-level trace id; `emit` falls back to
  the diagnostics ambient trace resolver, which is correct.

## Component 2 — `DurableDiagnosticsModule`

```ts
import {
  Global, Module, type DynamicModule, type OnApplicationBootstrap, type OnApplicationShutdown,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { attachDurableDiagnostics } from './attach-durable-diagnostics';

class DurableDiagnosticsAttacher implements OnApplicationBootstrap, OnApplicationShutdown {
  private off: (() => void) | null = null;
  constructor(private readonly moduleRef: ModuleRef) {}

  onApplicationBootstrap(): void {
    const engine = this.moduleRef.get(WorkflowEngine, { strict: false });
    this.off = attachDurableDiagnostics(engine);
  }
  onApplicationShutdown(): void {
    this.off?.();
    this.off = null;
  }
}

@Global()
@Module({})
export class DurableDiagnosticsModule {
  static forRoot(): DynamicModule {
    return { module: DurableDiagnosticsModule, providers: [DurableDiagnosticsAttacher] };
  }
}
```

- Resolves the **already-constructed** `WorkflowEngine` from the container at bootstrap
  (`strict: false`, exactly like the Telescope watcher) — does not construct or own it.
- Attach happens on `onApplicationBootstrap` (after `DurableModule` has provided the engine) and is
  released on `onApplicationShutdown` so a closed app stops emitting.
- Usage:
  ```ts
  @Module({ imports: [DurableModule.forRoot({ … }), DurableDiagnosticsModule.forRoot()] })
  export class AppModule {}
  ```

## Component 3 — `ChannelRegistry` augmentation (typed payloads)

```ts
import type { EngineEvent } from '@dudousxd/nestjs-durable-core';

declare module '@dudousxd/nestjs-diagnostics' {
  interface ChannelRegistry {
    durable: {
      'run.started': EngineEvent;
      'run.completed': EngineEvent;
      'run.failed': EngineEvent;
      'run.suspended': EngineEvent;
      'step.started': EngineEvent;
      'step.completed': EngineEvent;
      'step.failed': EngineEvent;
      'step.progress': EngineEvent;
    };
  }
}
```

Re-exported (`import './channel-registry.js'` side-effect or `export {}` from the barrel) so any
consumer importing `@dudousxd/nestjs-durable-diagnostics` gets `@OnDiagnostic('durable', 'run.failed')`
and `getChannel('durable', 'run.failed')` typed to `EngineEvent`. Purely additive — every other
diagnostics pair is unaffected.

## Public exports (`src/index.ts`)

```ts
export { attachDurableDiagnostics } from './attach-durable-diagnostics';
export { DurableDiagnosticsModule } from './durable-diagnostics.module';
import './channel-registry'; // side-effect: registers the typed durable channels
```

## Testing

Tests use a **real `WorkflowEngine` with `InMemoryStateStore`** and a real diagnostics channel
subscription — the same harness style as `durable-otel.spec.ts`. Reset diagnostics registry state
between tests (`resetRegistry()` from `@dudousxd/nestjs-diagnostics`) and unsubscribe channels in
`afterEach` so the zero-cost gate is exercised cleanly.

**`attach-durable-diagnostics.spec.ts`:**
- subscribing `getChannel('durable', 'run.started')` then running a workflow delivers a
  `DiagnosticEvent` whose `payload` is the `EngineEvent` (`runId`, `workflow`, `at` present);
- a `step.completed` emission reaches `aviary:durable:step.completed` with the step `name`/`seq`;
- a failing run emits `run.failed` carrying `payload.error`;
- the returned unsubscribe stops further emissions (run a second workflow → no new channel message);
- **zero-cost / never-throw:** with no channel subscriber, running a workflow does not throw and the
  engine completes normally (the bridge is attached but every `emit` short-circuits on
  `hasSubscribers`).

**`durable-diagnostics.module.spec.ts`** (`@nestjs/testing`):
- a Nest app importing `DurableModule.forRoot(...)` + `DurableDiagnosticsModule.forRoot()` emits on
  `aviary:durable:run.started` when a workflow runs (proves `ModuleRef` resolves the engine and the
  bootstrap attach fires);
- after `app.close()`, a further run emits nothing on the channel (shutdown unsubscribed).

**Type-level (compile-only, in a spec):** `getChannel('durable', 'run.failed')` payload is assignable
to `EngineEvent` — guards the registry augmentation.

## Build & packaging

- `package.json`: copy `packages/otel/package.json`; rename to
  `@dudousxd/nestjs-durable-diagnostics`, `directory: "packages/diagnostics"`, description "Aviary
  diagnostics bus integration for nestjs-durable — every run/step event on `aviary:durable:*`".
  `peerDependencies`: `@dudousxd/nestjs-durable-core` (same range as otel),
  `@dudousxd/nestjs-diagnostics` (`>=0 <1` / current), `@nestjs/common` + `@nestjs/core` (optional via
  `peerDependenciesMeta`). `devDependencies`: those four + `typescript`/`tsup` matching otel.
- `tsup.config.ts` and `tsconfig.json`: identical to `packages/otel`.
- Add a changeset (new package → minor on `@dudousxd/nestjs-durable-diagnostics`).
- README: install, `DurableDiagnosticsModule.forRoot()` snippet, the channel-name table, an
  `@OnDiagnostic('durable', 'run.failed')` example, and a note that it is additive to OTel/Telescope.

## Out of scope (v1)

- **Onboarding `notifications`** to diagnostics — the parallel roadmap sub-project; same shape once
  its event source is located. Separate spec/plan.
- **Cross-process transport** — diagnostics stays in-process; a consumer-side forwarder is a later
  roadmap item.
- **Selective/sampled emission** (e.g. dropping `step.progress`) — forward everything; the
  subscribe-side filter plus the `hasSubscribers` gate already make it free. Revisit only if a real
  hot-path cost shows up.
- **Aviary docs page** for the new package — add after the build lands (durable docs are synced into
  the Aviary site; a `diagnostics` integration page mirrors the existing `otel`/`telescope` ones).
