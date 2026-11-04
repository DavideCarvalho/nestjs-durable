import type { EngineEvent, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import {
  type Link,
  type Span,
  type SpanContext,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
  context,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';

/** An event another instance produced and the control plane re-delivered here (see the core's
 *  `isRemoteEvent`); read by symbol so an older core, which marks none, still works. */
const REMOTE_EVENT = Symbol.for('@dudousxd/nestjs-durable:remote-event');
const isRemote = (event: object): boolean =>
  (event as { [REMOTE_EVENT]?: unknown })[REMOTE_EVENT] === true;

/** How many runs' span contexts are kept after their span ended, for subscribers to link to. */
const ENDED_RUN_CONTEXTS = 10_000;

/** A span context as a W3C `traceparent`. */
function toTraceparent(ctx: SpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${(ctx.traceFlags & 0xff).toString(16).padStart(2, '0')}`;
}

/** The span context a W3C `traceparent` names, or undefined when it is not a valid one. */
function fromTraceparent(traceparent: string | undefined): SpanContext | undefined {
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
    traceparent?.trim().toLowerCase() ?? '',
  );
  if (!match || match[1] === 'ff') return undefined;
  const ctx: SpanContext = {
    traceId: match[2] as string,
    spanId: match[3] as string,
    traceFlags: Number.parseInt(match[4] as string, 16),
    isRemote: true,
  };
  return isSpanContextValid(ctx) ? ctx : undefined;
}

/**
 * The run a lifecycle event started `runId` from: its id is `evt:<source>:<kind>:<workflow>` (the
 * core's `lifecycleRunId`). Parsed here rather than imported so an older core still works.
 */
function lifecycleSource(
  runId: string,
  workflow: string | undefined,
): { runId: string; kind: 'completed' | 'failed' } | undefined {
  if (!workflow || !runId.startsWith('evt:')) return undefined;
  for (const kind of ['completed', 'failed'] as const) {
    const suffix = `:${kind}:${workflow}`;
    if (runId.endsWith(suffix) && runId.length > 'evt:'.length + suffix.length) {
      return { runId: runId.slice('evt:'.length, -suffix.length), kind };
    }
  }
  return undefined;
}

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
 *
 * A run a lifecycle event started (`@OnWorkflowCompleted`, `onEvent: [runCompletedEvent(...)]`) has
 * its root span linked to the source run's span, with `durable.lifecycle.source_run_id` and
 * `durable.lifecycle.kind` attributes. The bridge installs the engine's run trace provider
 * (`engine.setRunTraceparent`), so a run some workflow subscribes to records its root span's
 * traceparent on its first suspend or its terminal write, whichever comes first, and the link holds
 * when the run resumes, settles or starts its subscriber in another process.
 */
export function attachDurableOtel(engine: WorkflowEngine, options: DurableOtelOptions = {}) {
  const tracer =
    options.tracer ?? (options.provider ?? trace).getTracer('@dudousxd/nestjs-durable', '0.1.0');
  const roots = new Map<string, Span>();
  const ended = new Map<string, SpanContext>();

  const remember = (runId: string, ctx: SpanContext) => {
    ended.delete(runId);
    ended.set(runId, ctx);
    if (ended.size > ENDED_RUN_CONTEXTS) {
      const oldest = ended.keys().next().value;
      if (oldest !== undefined) ended.delete(oldest);
    }
  };
  const runTraceparent = (runId: string): string | undefined => {
    const ctx = roots.get(runId)?.spanContext() ?? ended.get(runId);
    return ctx && isSpanContextValid(ctx) ? toTraceparent(ctx) : undefined;
  };
  if (typeof engine.setRunTraceparent === 'function') engine.setRunTraceparent(runTraceparent);

  const endRoot = (
    event: EngineEvent,
    status?: { error?: boolean | undefined; message?: string | undefined },
  ) => {
    const span = roots.get(event.runId);
    if (!span) return;
    if (status?.error) {
      span.setStatus(
        status.message !== undefined
          ? { code: SpanStatusCode.ERROR, message: status.message }
          : { code: SpanStatusCode.ERROR },
      );
    }
    span.end(event.at);
    roots.delete(event.runId);
    remember(event.runId, span.spanContext());
  };

  const unsubscribe = engine.subscribe((event) => {
    if (isRemote(event)) return;
    switch (event.type) {
      case 'run.started': {
        const source = lifecycleSource(event.runId, event.workflow);
        const sourceContext = source
          ? (fromTraceparent(event.sourceTraceparent) ??
            roots.get(source.runId)?.spanContext() ??
            ended.get(source.runId))
          : undefined;
        const links: Link[] = sourceContext ? [{ context: sourceContext }] : [];
        const span = tracer.startSpan(`workflow ${event.workflow ?? '?'}`, {
          startTime: event.at,
          attributes: {
            'durable.run_id': event.runId,
            'durable.workflow': event.workflow,
            ...(source
              ? {
                  'durable.lifecycle.source_run_id': source.runId,
                  'durable.lifecycle.kind': source.kind,
                }
              : {}),
          },
          links,
        });
        roots.set(event.runId, span);
        break;
      }
      case 'step.completed':
      case 'step.failed': {
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
        if (event.type === 'step.failed') {
          const message = event.error?.message;
          span.setStatus(
            message !== undefined
              ? { code: SpanStatusCode.ERROR, message }
              : { code: SpanStatusCode.ERROR },
          );
        }
        span.end(event.at);
        break;
      }
      // Both are emitted while the run's span is still open: the handoff before the run suspends on its
      // handler, the unrouted failure before the run fails.
      case 'run.routed':
        roots.get(event.runId)?.addEvent(
          'durable.run.routed',
          {
            'durable.on_error.handler': event.name,
            'durable.error.code': event.error?.code,
            'durable.error.message': event.error?.message,
          },
          event.at,
        );
        break;
      case 'run.unrouted':
        roots.get(event.runId)?.addEvent(
          'durable.run.unrouted',
          {
            'durable.on_error.reason': event.reason,
            'durable.error.code': event.error?.code,
          },
          event.at,
        );
        break;
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
  return () => {
    unsubscribe();
    if (typeof engine.setRunTraceparent === 'function') engine.setRunTraceparent(undefined);
  };
}
