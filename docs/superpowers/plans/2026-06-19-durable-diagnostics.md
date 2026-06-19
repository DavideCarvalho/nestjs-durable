# `@dudousxd/nestjs-durable-diagnostics` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new `@dudousxd/nestjs-durable-diagnostics` package that re-emits every `WorkflowEngine` lifecycle event onto the Aviary diagnostics bus (`aviary:durable:<type>`), with an optional Nest module and typed `ChannelRegistry` augmentation.

**Architecture:** A thin subscriber on `engine.subscribe(...)` calls `emit('durable', event.type, event)` for every event. The primitive `attachDurableDiagnostics(engine)` mirrors the existing `attachDurableOtel` exactly (same package shape, same build). A global Nest module resolves the engine from `ModuleRef` and attaches on bootstrap. A declaration-merge file adds typed payloads. Additive — durable's OTel/Telescope integrations are untouched.

**Tech Stack:** TypeScript, tsup (dual ESM+CJS, `moduleResolution: Bundler`), vitest (root config), pnpm workspace. Peers: `@dudousxd/nestjs-durable-core`, `@dudousxd/nestjs-diagnostics`; `@nestjs/common` + `@nestjs/core` + `reflect-metadata` optional.

**Spec:** `docs/superpowers/specs/2026-06-19-durable-diagnostics-design.md`

## Global Constraints

- Package name: `@dudousxd/nestjs-durable-diagnostics`, directory `packages/diagnostics`.
- **Mirror `packages/otel`** for `tsup.config.ts` and `tsconfig.json` (copy verbatim) and for `package.json` structure (dual ESM+CJS `exports`, `main: ./dist/index.cjs`, `module: ./dist/index.js`, `types: ./dist/index.d.ts`).
- Channel names use the **dotted event type verbatim**: `emit('durable', event.type, event)` → `aviary:durable:run.started`, …`step.progress`. No translation, no per-type branching — forward **all eight** `EngineEventType`s.
- Peer ranges: `@dudousxd/nestjs-durable-core` `">=0.1.0 <1.0.0"`, `@dudousxd/nestjs-diagnostics` `"^0.3.0"`. Nest peers `"^10.0.0 || ^11.0.0"`, `reflect-metadata` `"^0.2.0"` — all four optional via `peerDependenciesMeta`.
- Specs run under the existing root `vitest.config.ts` (`pnpm exec vitest run <path>` from repo root) — no per-package vitest config. Reset diagnostics state between tests with `resetRegistry()` and unsubscribe channels in `afterEach`.
- Every commit body ends with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work happens in the worktree on branch `feat/durable-diagnostics`.

---

### Task 1: Package scaffold + `attachDurableDiagnostics`

**Files:**
- Create: `packages/diagnostics/package.json`
- Create: `packages/diagnostics/tsup.config.ts`
- Create: `packages/diagnostics/tsconfig.json`
- Create: `packages/diagnostics/src/attach-durable-diagnostics.ts`
- Create: `packages/diagnostics/src/index.ts`
- Test: `packages/diagnostics/src/attach-durable-diagnostics.spec.ts`

**Interfaces:**
- Consumes: `WorkflowEngine`, `EngineEvent`, `InMemoryStateStore` from `@dudousxd/nestjs-durable-core`; `emit`, `getChannel`, `resetRegistry`, `type DiagnosticEvent` from `@dudousxd/nestjs-diagnostics`.
- Produces: `attachDurableDiagnostics(engine: WorkflowEngine): () => void`.

- [ ] **Step 1: Scaffold the package files**

`packages/diagnostics/package.json`:

```json
{
  "name": "@dudousxd/nestjs-durable-diagnostics",
  "version": "0.0.0",
  "description": "Aviary diagnostics bus integration for nestjs-durable — every run/step event on aviary:durable:*",
  "license": "MIT",
  "author": "Davide Carvalho",
  "repository": {
    "type": "git",
    "url": "https://github.com/DavideCarvalho/nestjs-durable.git",
    "directory": "packages/diagnostics"
  },
  "type": "module",
  "main": "./dist/index.cjs",
  "types": "./dist/index.d.ts",
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": {
    "@dudousxd/nestjs-durable-core": ">=0.1.0 <1.0.0",
    "@dudousxd/nestjs-diagnostics": "^0.3.0",
    "@nestjs/common": "^10.0.0 || ^11.0.0",
    "@nestjs/core": "^10.0.0 || ^11.0.0",
    "reflect-metadata": "^0.2.0"
  },
  "peerDependenciesMeta": {
    "@nestjs/common": { "optional": true },
    "@nestjs/core": { "optional": true },
    "reflect-metadata": { "optional": true }
  },
  "devDependencies": {
    "@dudousxd/nestjs-durable-core": "workspace:^",
    "@dudousxd/nestjs-diagnostics": "^0.3.0",
    "@nestjs/common": "11.1.26",
    "@nestjs/core": "11.1.26",
    "@nestjs/testing": "11.1.26",
    "reflect-metadata": "0.2.2",
    "typescript": "5.9.3",
    "tsup": "8.3.5"
  },
  "module": "./dist/index.js",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  }
}
```

`packages/diagnostics/tsup.config.ts` (copy of `packages/otel/tsup.config.ts`):

```ts
import { defineConfig } from 'tsup';

// Dual ESM + CJS publish (matches `core` and the ecosystem standard). ESM is the primary build
// (index.js + index.d.ts); CJS is the `require` fallback (index.cjs + index.d.cts). The conditional
// `exports` map in package.json points each consumer condition at the matching pair.
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
]);
```

`packages/diagnostics/tsconfig.json` (copy of `packages/otel/tsconfig.json`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "src/**/*.spec.ts", "dist", "node_modules"]
}
```

- [ ] **Step 2: Install workspace deps**

Run from repo root: `pnpm install`
Expected: pnpm links the new package; `@dudousxd/nestjs-diagnostics` and `@nestjs/*` resolve in `packages/diagnostics/node_modules`.

- [ ] **Step 3: Write the failing test**

`packages/diagnostics/src/attach-durable-diagnostics.spec.ts`:

```ts
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { type DiagnosticEvent, getChannel, resetRegistry } from '@dudousxd/nestjs-diagnostics';
import { afterEach, describe, expect, it } from 'vitest';
import { attachDurableDiagnostics } from './attach-durable-diagnostics';

/** Subscribe to one durable channel and collect the payloads it receives. Returns the captured
 *  array plus an unsubscribe to call in afterEach. */
function capture(event: string) {
  const seen: unknown[] = [];
  const listener = (msg: unknown) => seen.push((msg as DiagnosticEvent).payload);
  const channel = getChannel('durable', event);
  channel.subscribe(listener);
  return { seen, off: () => channel.unsubscribe(listener) };
}

describe('attachDurableDiagnostics', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    resetRegistry();
  });

  it('emits run.started on aviary:durable:run.started with the EngineEvent payload', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    cleanups.push(attachDurableDiagnostics(engine));
    const started = capture('run.started');
    cleanups.push(started.off);

    engine.register('checkout', '1', async () => 'ok');
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    expect(started.seen.length).toBeGreaterThanOrEqual(1);
    const ev = started.seen[0] as { type: string; runId: string; workflow?: string; at: Date };
    expect(ev.type).toBe('run.started');
    expect(ev.runId).toBe('run1');
    expect(ev.workflow).toBe('checkout');
    expect(ev.at).toBeInstanceOf(Date);
  });

  it('emits step.completed with the step name/seq', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    cleanups.push(attachDurableDiagnostics(engine));
    const step = capture('step.completed');
    cleanups.push(step.off);

    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('charge', async () => 1);
      return 'ok';
    });
    await engine.start('checkout', {}, 'run2');
    await engine.waitForRun('run2');

    expect(step.seen.length).toBeGreaterThanOrEqual(1);
    const ev = step.seen[0] as { type: string; name?: string };
    expect(ev.type).toBe('step.completed');
    expect(ev.name).toBe('charge');
  });

  it('emits run.failed carrying the error', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    cleanups.push(attachDurableDiagnostics(engine));
    const failed = capture('run.failed');
    cleanups.push(failed.off);

    engine.register('boom', '1', async () => {
      throw new Error('kaboom');
    });
    await engine.start('boom', {}, 'run3');
    await engine.waitForRun('run3').catch(() => undefined);

    expect(failed.seen.length).toBeGreaterThanOrEqual(1);
    const ev = failed.seen[0] as { type: string; error?: { message?: string } };
    expect(ev.type).toBe('run.failed');
    expect(ev.error?.message).toContain('kaboom');
  });

  it('stops emitting after the returned unsubscribe is called', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const off = attachDurableDiagnostics(engine);
    const started = capture('run.started');
    cleanups.push(started.off);
    off(); // detach the bridge

    engine.register('checkout', '1', async () => 'ok');
    await engine.start('checkout', {}, 'run4');
    await engine.waitForRun('run4');

    expect(started.seen.length).toBe(0);
  });

  it('is zero-cost and never throws when no channel is subscribed', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    cleanups.push(attachDurableDiagnostics(engine)); // attached, but nobody subscribes a channel

    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('charge', async () => 1);
      return 'ok';
    });
    await engine.start('checkout', {}, 'run5');
    await expect(engine.waitForRun('run5')).resolves.toBeDefined();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/diagnostics/src/attach-durable-diagnostics.spec.ts`
Expected: FAIL — `attach-durable-diagnostics` module / `attachDurableDiagnostics` not found.

- [ ] **Step 5: Write the implementation**

`packages/diagnostics/src/attach-durable-diagnostics.ts`:

```ts
import { type EngineEvent, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { emit } from '@dudousxd/nestjs-diagnostics';

/**
 * Re-emit every engine lifecycle event onto the Aviary diagnostics bus as `aviary:durable:<type>`
 * (e.g. `aviary:durable:run.failed`). The whole {@link EngineEvent} is the diagnostics payload.
 *
 * All eight `EngineEventType`s are forwarded verbatim — including the high-frequency `step.progress`
 * and `step.started`. Filtering is the subscriber's job; `emit` short-circuits on `hasSubscribers`,
 * so an unsubscribed channel costs nothing, and it never throws back into the engine. Additive to the
 * OTel and Telescope integrations, which subscribe to the same engine bus independently.
 *
 * @returns an unsubscribe function that detaches the bridge from the engine.
 */
export function attachDurableDiagnostics(engine: WorkflowEngine): () => void {
  return engine.subscribe((event: EngineEvent) => {
    emit('durable', event.type, event);
  });
}
```

`packages/diagnostics/src/index.ts`:

```ts
export { attachDurableDiagnostics } from './attach-durable-diagnostics';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/diagnostics/src/attach-durable-diagnostics.spec.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @dudousxd/nestjs-durable-diagnostics typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/diagnostics pnpm-lock.yaml
git commit -F - <<'EOF'
feat(diagnostics): attachDurableDiagnostics bridge to the Aviary bus

New @dudousxd/nestjs-durable-diagnostics package. attachDurableDiagnostics(engine)
re-emits every WorkflowEngine lifecycle event over @dudousxd/nestjs-diagnostics on
aviary:durable:<type>. Forwards all eight event types verbatim; zero-cost when no
channel is subscribed; never throws back into the engine. Mirrors the otel package.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Typed `ChannelRegistry` augmentation

**Files:**
- Create: `packages/diagnostics/src/channel-registry.ts`
- Modify: `packages/diagnostics/src/index.ts` (add side-effect import)
- Test: `packages/diagnostics/src/channel-registry.spec.ts`

**Interfaces:**
- Consumes: `type EngineEvent` from `@dudousxd/nestjs-durable-core`; augments `ChannelRegistry` in `@dudousxd/nestjs-diagnostics`.
- Produces: typed `('durable', <EngineEventType>)` channels — `getChannel`/`emit`/`@OnDiagnostic` infer `payload: EngineEvent`.

- [ ] **Step 1: Write the failing (compile-only) test**

`packages/diagnostics/src/channel-registry.spec.ts`:

```ts
import type { EngineEvent } from '@dudousxd/nestjs-durable-core';
import { getChannel } from '@dudousxd/nestjs-diagnostics';
import { describe, expectTypeOf, it } from 'vitest';
import './channel-registry';

describe('durable ChannelRegistry augmentation', () => {
  it('types getChannel("durable", "run.failed") payload as EngineEvent', () => {
    const channel = getChannel('durable', 'run.failed');
    channel.subscribe((msg) => {
      // The registry declaration-merge makes the published-message payload an EngineEvent.
      const event = (msg as { payload: unknown }).payload as EngineEvent;
      expectTypeOf(event.type).toEqualTypeOf<EngineEvent['type']>();
      expectTypeOf(event.runId).toBeString();
    });
  });
});
```

(Note: this is primarily a compile-time guard; the assertions ensure `EngineEvent` is importable and the keys exist. If `getChannel`'s typed-payload inference is not surfaced through the public type, the `expectTypeOf` lines still validate the augmentation file compiles against the real `EngineEvent`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/diagnostics/src/channel-registry.spec.ts`
Expected: FAIL — `./channel-registry` module not found.

- [ ] **Step 3: Write the augmentation**

`packages/diagnostics/src/channel-registry.ts`:

```ts
import type { EngineEvent } from '@dudousxd/nestjs-durable-core';

// Declaration-merge durable's eight lifecycle channels into the diagnostics ChannelRegistry so
// `@OnDiagnostic('durable', 'run.failed')`, `getChannel('durable', 'run.failed')`, and
// `emit('durable', 'run.failed', …)` all infer a typed `EngineEvent` payload. Purely additive —
// every other (lib, event) pair keeps its existing payload type.
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

- [ ] **Step 4: Wire the side-effect import into the barrel**

Modify `packages/diagnostics/src/index.ts` to:

```ts
export { attachDurableDiagnostics } from './attach-durable-diagnostics';
import './channel-registry'; // side-effect: registers the typed durable channels
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/diagnostics/src/channel-registry.spec.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @dudousxd/nestjs-durable-diagnostics typecheck`
Expected: no errors (the `emit('durable', event.type, event)` call in Task 1 now resolves against the typed registry and must still accept `EngineEvent`).

- [ ] **Step 7: Commit**

```bash
git add packages/diagnostics/src
git commit -F - <<'EOF'
feat(diagnostics): typed ChannelRegistry augmentation for durable channels

Declaration-merge durable's eight lifecycle channels into the diagnostics
ChannelRegistry so @OnDiagnostic('durable', ...) and getChannel('durable', ...)
infer a typed EngineEvent payload. Loaded as a side-effect from the barrel.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: `DurableDiagnosticsModule`

**Files:**
- Create: `packages/diagnostics/src/durable-diagnostics.module.ts`
- Modify: `packages/diagnostics/src/index.ts` (export the module)
- Test: `packages/diagnostics/src/durable-diagnostics.module.spec.ts`

**Interfaces:**
- Consumes: `WorkflowEngine` (DI token) from `@dudousxd/nestjs-durable-core`; `ModuleRef` from `@nestjs/core`; Nest lifecycle hooks from `@nestjs/common`; `attachDurableDiagnostics` from Task 1.
- Produces: `DurableDiagnosticsModule.forRoot(): DynamicModule` — global; attaches on bootstrap, detaches on shutdown.

- [ ] **Step 1: Write the failing test**

`packages/diagnostics/src/durable-diagnostics.module.spec.ts`:

```ts
import 'reflect-metadata';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { type DiagnosticEvent, getChannel, resetRegistry } from '@dudousxd/nestjs-diagnostics';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableDiagnosticsModule } from './durable-diagnostics.module';

function capture(event: string) {
  const seen: unknown[] = [];
  const listener = (msg: unknown) => seen.push((msg as DiagnosticEvent).payload);
  const channel = getChannel('durable', event);
  channel.subscribe(listener);
  return { seen, off: () => channel.unsubscribe(listener) };
}

describe('DurableDiagnosticsModule', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    resetRegistry();
  });

  it('attaches on bootstrap so a workflow run emits on aviary:durable:run.started', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({}), DurableDiagnosticsModule.forRoot()],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    cleanups.push(() => void app.close());

    const started = capture('run.started');
    cleanups.push(started.off);

    const engine = app.get(WorkflowEngine);
    engine.register('checkout', '1', async () => 'ok');
    await engine.start('checkout', {}, 'm-run1');
    await engine.waitForRun('m-run1');

    expect(started.seen.length).toBeGreaterThanOrEqual(1);
  });

  it('detaches on app.close so later runs emit nothing', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({}), DurableDiagnosticsModule.forRoot()],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const engine = app.get(WorkflowEngine);
    engine.register('checkout', '1', async () => 'ok');

    await app.close(); // shutdown unsubscribes the bridge

    const started = capture('run.started');
    cleanups.push(started.off);
    await engine.start('checkout', {}, 'm-run2');
    await engine.waitForRun('m-run2');

    expect(started.seen.length).toBe(0);
  });
});
```

(If `DurableModule.forRoot({})` requires a store option to boot, pass the in-memory store the durable test suite uses — check `packages/nestjs/src/durable.spec.ts` for the exact `forRoot` shape and mirror it. The assertion contract above does not change.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/diagnostics/src/durable-diagnostics.module.spec.ts`
Expected: FAIL — `durable-diagnostics.module` / `DurableDiagnosticsModule` not found.

- [ ] **Step 3: Write the module**

`packages/diagnostics/src/durable-diagnostics.module.ts`:

```ts
import {
  type DynamicModule,
  Global,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { attachDurableDiagnostics } from './attach-durable-diagnostics';

/** Resolves the already-constructed engine from the container on bootstrap and attaches the
 *  diagnostics bridge; detaches on shutdown. Does not construct or own the engine. */
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

/**
 * Import once at the app root (alongside `DurableModule`) to put durable on the Aviary diagnostics
 * bus — every run/step event is then observable via `@OnDiagnostic('durable', ...)` or any
 * `getChannel('durable', ...)` subscriber, with no extra dependencies.
 *
 * ```ts
 * @Module({ imports: [DurableModule.forRoot({ ... }), DurableDiagnosticsModule.forRoot()] })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({})
export class DurableDiagnosticsModule {
  static forRoot(): DynamicModule {
    return {
      module: DurableDiagnosticsModule,
      providers: [DurableDiagnosticsAttacher],
    };
  }
}
```

- [ ] **Step 4: Export the module from the barrel**

Modify `packages/diagnostics/src/index.ts` to:

```ts
export { attachDurableDiagnostics } from './attach-durable-diagnostics';
export { DurableDiagnosticsModule } from './durable-diagnostics.module';
import './channel-registry'; // side-effect: registers the typed durable channels
```

- [ ] **Step 5: Add `@dudousxd/nestjs-durable` as a dev dependency (the module test imports `DurableModule`)**

Add `"@dudousxd/nestjs-durable": "workspace:^"` to `packages/diagnostics/package.json` `devDependencies`, then run from repo root: `pnpm install`
Expected: the nestjs package resolves for the test.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/diagnostics/src/durable-diagnostics.module.spec.ts`
Expected: PASS — both tests green.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @dudousxd/nestjs-durable-diagnostics typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/diagnostics pnpm-lock.yaml
git commit -F - <<'EOF'
feat(diagnostics): DurableDiagnosticsModule for import-and-forget wiring

Global Nest module that resolves WorkflowEngine from ModuleRef on bootstrap and
attaches the diagnostics bridge, detaching on shutdown. Import alongside
DurableModule to put durable on the Aviary bus with no manual attach call.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: README + changeset

**Files:**
- Create: `packages/diagnostics/README.md`
- Create: `.changeset/<descriptive-name>.md`

- [ ] **Step 1: Write the README**

`packages/diagnostics/README.md`:

````markdown
# @dudousxd/nestjs-durable-diagnostics

Put [`nestjs-durable`](https://github.com/DavideCarvalho/nestjs-durable) on the Aviary diagnostics
bus. Every `WorkflowEngine` lifecycle event is re-emitted over
[`@dudousxd/nestjs-diagnostics`](https://github.com/DavideCarvalho/nestjs-diagnostics) on the
**`aviary:durable:<type>`** channels — so `@OnDiagnostic('durable', 'run.failed')`, the Telescope
diagnostics watcher, or any `getChannel('durable', …)` subscriber reacts to workflow events with no
extra dependencies. Additive: your existing OTel and Telescope integrations are untouched.

## Install

```bash
pnpm add @dudousxd/nestjs-durable-diagnostics @dudousxd/nestjs-diagnostics
```

## Use (Nest)

```ts
import { DurableModule } from '@dudousxd/nestjs-durable';
import { DurableDiagnosticsModule } from '@dudousxd/nestjs-durable-diagnostics';

@Module({
  imports: [DurableModule.forRoot({ /* ... */ }), DurableDiagnosticsModule.forRoot()],
})
export class AppModule {}
```

React anywhere with the diagnostics decorator:

```ts
import { Injectable } from '@nestjs/common';
import { OnDiagnostic } from '@dudousxd/nestjs-diagnostics/nestjs';
import type { EngineEvent } from '@dudousxd/nestjs-durable-core';

@Injectable()
export class WorkflowAlerts {
  @OnDiagnostic('durable', 'run.failed')
  onRunFailed(event: { payload: EngineEvent }) {
    // page on repeated failures, write an audit row, ...
  }
}
```

## Use (manual / non-Nest)

```ts
import { attachDurableDiagnostics } from '@dudousxd/nestjs-durable-diagnostics';

const detach = attachDurableDiagnostics(engine); // engine: WorkflowEngine
// ... later
detach();
```

## Channels

Every `EngineEventType` is forwarded verbatim. The whole `EngineEvent` is the payload.

| Channel | When |
| --- | --- |
| `aviary:durable:run.started` | a run begins |
| `aviary:durable:run.completed` | a run finishes successfully |
| `aviary:durable:run.failed` | a run fails (`payload.error`) |
| `aviary:durable:run.suspended` | a run suspends (timer/signal) |
| `aviary:durable:step.started` | a step begins |
| `aviary:durable:step.completed` | a step finishes |
| `aviary:durable:step.failed` | a step fails (`payload.error`) |
| `aviary:durable:step.progress` | a live step event (log line / sub-process outcome) |

Emission is **zero-cost when no one is subscribed** — diagnostics short-circuits before allocating —
and never throws back into the engine.
````

- [ ] **Step 2: Write the changeset**

`.changeset/durable-diagnostics.md`:

```markdown
---
"@dudousxd/nestjs-durable-diagnostics": minor
---

Add `@dudousxd/nestjs-durable-diagnostics`: bridge WorkflowEngine lifecycle events onto the Aviary diagnostics bus (`aviary:durable:<type>`). Ships `attachDurableDiagnostics(engine)`, a global `DurableDiagnosticsModule`, and a typed `ChannelRegistry` augmentation so `@OnDiagnostic('durable', ...)` infers an `EngineEvent` payload.
```

- [ ] **Step 3: Verify the package builds**

Run: `pnpm --filter @dudousxd/nestjs-durable-diagnostics build`
Expected: `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`, `dist/index.d.cts` produced; no errors.

- [ ] **Step 4: Run the full package test suite once more**

Run: `pnpm exec vitest run packages/diagnostics`
Expected: all specs across the three spec files pass.

- [ ] **Step 5: Commit**

```bash
git add packages/diagnostics/README.md .changeset/durable-diagnostics.md
git commit -F - <<'EOF'
docs(diagnostics): README and changeset for nestjs-durable-diagnostics

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Self-Review

**Spec coverage:**
- `attachDurableDiagnostics` primitive → Task 1. ✅
- All eight events forwarded verbatim, dotted channel names → Task 1 (impl + tests cover run.started/step.completed/run.failed; zero-cost path tested). ✅
- `DurableDiagnosticsModule` (bootstrap attach + shutdown detach via ModuleRef) → Task 3. ✅
- Typed `ChannelRegistry` augmentation → Task 2. ✅
- Package mirrors otel build (tsup dual ESM+CJS, tsconfig Bundler, exports map) → Task 1 scaffold. ✅
- Optional Nest peers via `peerDependenciesMeta` → Task 1 package.json. ✅
- README + changeset → Task 4. ✅

**Type consistency:** `attachDurableDiagnostics(engine: WorkflowEngine): () => void` is referenced identically in Tasks 1, 3. `EngineEvent` payload typing in Task 2 matches the `emit('durable', event.type, event)` call in Task 1. Channel names use the dotted `EngineEventType` strings throughout.

**Open verification deferred to implementer (flagged inline, not placeholders):**
- Task 3 Step 1 note: confirm `DurableModule.forRoot({})` boot args against `packages/nestjs/src/durable.spec.ts` (the assertion contract is fixed regardless).
- Task 2 Step 1 note: `getChannel` typed-payload surfacing — the augmentation compiling against the real `EngineEvent` is the guaranteed guard; deeper inference is a bonus.
