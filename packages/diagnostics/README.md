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

React anywhere by subscribing to the channel — needs nothing beyond diagnostics:

```ts
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { getChannel, type DiagnosticEvent } from '@dudousxd/nestjs-diagnostics';
import type { EngineEvent } from '@dudousxd/nestjs-durable-core';

@Injectable()
export class WorkflowAlerts implements OnModuleInit {
  onModuleInit() {
    getChannel('durable', 'run.failed').subscribe((msg) => {
      const event = (msg as DiagnosticEvent).payload as EngineEvent;
      // page on repeated failures, write an audit row, ...
    });
  }
}
```

Or, with a diagnostics version that ships the `/nestjs` subpath (the `@OnDiagnostic`
decorator), the same reaction is one annotation — the typed `ChannelRegistry` augmentation
this package contributes infers the `EngineEvent` payload for you:

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
