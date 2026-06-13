import { ROOT_CONTEXT, context, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { beforeAll, describe, expect, it } from 'vitest';
import { otelTraceparent } from './traceparent';

describe('otelTraceparent', () => {
  beforeAll(() => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  it('renders the active span as a W3C traceparent', () => {
    const tracer = new BasicTracerProvider().getTracer('test');
    const span = tracer.startSpan('op');
    const ctx = trace.setSpan(context.active(), span);

    const tp = otelTraceparent(ctx);
    span.end();

    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it('returns undefined when there is no active span', () => {
    expect(otelTraceparent(ROOT_CONTEXT)).toBeUndefined();
  });
});
