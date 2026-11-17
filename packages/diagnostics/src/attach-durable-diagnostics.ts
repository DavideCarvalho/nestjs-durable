import { type EmitOptions, emit } from '@dudousxd/nestjs-diagnostics';
import {
  type AttributedEngineEvent,
  type EngineEvent,
  type RunAppAttribution,
  RunAppStamper,
  WorkflowEngine,
  runTraceId,
} from '@dudousxd/nestjs-durable-core';
import { isDiagnosticsDeliveryEvent } from './delivery/transport';

/** An event another instance produced and the control plane re-delivered here (see the core's
 *  `isRemoteEvent`); read by symbol so an older core, which marks none, still works. */
const REMOTE_EVENT = Symbol.for('@dudousxd/nestjs-durable:remote-event');
const isRemote = (event: object): boolean =>
  (event as { [REMOTE_EVENT]?: unknown })[REMOTE_EVENT] === true;

/** Options for {@link attachDurableDiagnostics}. */
export interface DurableDiagnosticsOptions {
  /**
   * Attribute each event to the tenant app whose run it is. A control plane sets it (the
   * `DurableDiagnosticsModule` does, from `topology: 'control-plane'`), so it is the one place every
   * tenant's workflow lifecycle is recorded: every forwarded event of a tenant's run, step events
   * included, then carries `app: <tenant partition>`. Omitted (standalone): events are forwarded
   * exactly as the engine produced them.
   */
  tenants?: RunAppAttribution | undefined;
}

/**
 * Re-emit every engine lifecycle event onto the Aviary diagnostics bus as `aviary:durable:<type>`
 * (e.g. `aviary:durable:run.failed`). The whole {@link EngineEvent} is the diagnostics payload.
 *
 * Every `EngineEventType` is forwarded verbatim — including the high-frequency `step.progress`
 * and `step.started`. Filtering is the subscriber's job; `emit` short-circuits on `hasSubscribers`,
 * so an unsubscribed channel costs nothing, and it never throws back into the engine. Additive to the
 * OTel and Telescope integrations, which subscribe to the same engine bus independently.
 *
 * Events of the runs `transports.durable()` delivers listeners with are not forwarded: a listener on
 * `durable` events would otherwise cause a delivery run for every delivery run, without end.
 *
 * With {@link DurableDiagnosticsOptions.tenants} (a control plane), every event of a tenant's run
 * carries `app`, the tenant's partition, both in the payload and on the envelope (`emit`'s `app`
 * option, which `@dudousxd/nestjs-diagnostics` 0.12+ stamps and its Telescope watcher tags
 * `app:<name>`; an older version ignores it and the payload still names the app). Step events
 * resolve the app through a per-run cache, one store read for a run not seen yet, in emission order.
 * Each such event is emitted with its run's trace id ({@link runTraceId}): the trace a tenant pod
 * running the step under Telescope records the step's own work in. The control plane's own runs are
 * forwarded unchanged.
 *
 * @returns an unsubscribe function that detaches the bridge from the engine.
 */
export function attachDurableDiagnostics(
  engine: WorkflowEngine,
  options: DurableDiagnosticsOptions = {},
): () => void {
  const stamper = options.tenants ? new RunAppStamper(options.tenants) : undefined;
  return engine.subscribe((event: EngineEvent) => {
    if (isRemote(event) || isDiagnosticsDeliveryEvent(event)) return;
    if (stamper) stamper.stamp(event, forwardAttributed);
    else emit('durable', event.type, event);
  });
}

/** Emit an event the control plane attributed: a tenant's in its run trace, with `app`. */
function forwardAttributed(event: AttributedEngineEvent): void {
  if (event.app === undefined) {
    emit('durable', event.type, event);
    return;
  }
  // Typed wider than this package's `@dudousxd/nestjs-diagnostics` floor: an `emit` that predates
  // `app` ignores the extra option.
  const opts: EmitOptions & { app?: string } = { traceId: runTraceId(event.runId), app: event.app };
  emit('durable', event.type, event, opts);
}
