import { emit } from '@dudousxd/nestjs-diagnostics';
import { type EngineEvent, WorkflowEngine } from '@dudousxd/nestjs-durable-core';

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
