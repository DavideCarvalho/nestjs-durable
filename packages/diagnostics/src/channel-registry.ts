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
