import type { EngineEvent, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import {
  type Span,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
  context,
  trace,
} from '@opentelemetry/api';

export interface DurableOtelOptions {
  /** Tracer to use. Defaults to one from the global provider (or `provider` if given). */
  tracer?: Tracer;
  provider?: TracerProvider;
}

/**
 * Bridge engine lifecycle events to OpenTelemetry: one root span per run, one child span per
 * step (local/remote/sleep/signal), so a workflow shows up as a single distributed trace —
 * including remote steps once the worker continues the propagated context. Returns an
 * unsubscribe function.
 */
export function attachDurableOtel(engine: WorkflowEngine, options: DurableOtelOptions = {}) {
  const tracer =
    options.tracer ?? (options.provider ?? trace).getTracer('@dudousxd/nestjs-durable', '0.1.0');
  const roots = new Map<string, Span>();

  const endRoot = (event: EngineEvent, status?: { error?: boolean; message?: string }) => {
    const span = roots.get(event.runId);
    if (!span) return;
    if (status?.error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: status.message });
    }
    span.end(event.at);
    roots.delete(event.runId);
  };

  return engine.subscribe((event) => {
    switch (event.type) {
      case 'run.started': {
        const span = tracer.startSpan(`workflow ${event.workflow ?? '?'}`, {
          startTime: event.at,
          attributes: { 'durable.run_id': event.runId, 'durable.workflow': event.workflow },
        });
        roots.set(event.runId, span);
        break;
      }
      case 'step.completed': {
        const parent = roots.get(event.runId);
        const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
        const startTime =
          event.durationMs != null ? event.at.getTime() - event.durationMs : event.at;
        const span = tracer.startSpan(
          `step ${event.name ?? '?'}`,
          {
            startTime,
            attributes: {
              'durable.run_id': event.runId,
              'durable.step.seq': event.seq,
              'durable.step.kind': event.kind,
            },
          },
          ctx,
        );
        span.end(event.at);
        break;
      }
      case 'run.completed':
        endRoot(event);
        break;
      case 'run.suspended':
        endRoot(event);
        break;
      case 'run.failed':
        endRoot(event, { error: true, message: event.error?.message });
        break;
    }
  });
}
