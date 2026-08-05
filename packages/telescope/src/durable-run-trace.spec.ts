import { isSpanContextValid, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { runTraceContext, runTraceId } from './durable-run-trace';

describe('runTraceId', () => {
  it('is a valid W3C trace id — 32 lower-case hex chars, never all-zero', () => {
    const id = runTraceId('run-1');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toBe('0'.repeat(32));
  });

  it('is stable for a run — the property the whole design rests on', () => {
    // Two processes, two turns, ten minutes apart: same run id, same trace. Nothing is shared or
    // remembered to make this true.
    expect(runTraceId('run-1')).toBe(runTraceId('run-1'));
  });

  it('separates runs', () => {
    expect(runTraceId('run-1')).not.toBe(runTraceId('run-2'));
  });
});

describe('runTraceContext', () => {
  it('makes a valid, sampled span context active so spans started against it join the run', () => {
    const ctx = runTraceContext('run-1');
    const span = trace.getSpan(ctx);
    expect(span).toBeDefined();
    const spanContext = span?.spanContext();
    expect(spanContext).toBeDefined();
    if (!spanContext) throw new Error('no span context');
    expect(isSpanContextValid(spanContext)).toBe(true);
    expect(spanContext.traceId).toBe(runTraceId('run-1'));
    // Not sampled would leave every derived span non-recording, so it would never reach an exporter.
    expect(spanContext.traceFlags).toBe(1);
  });
});
