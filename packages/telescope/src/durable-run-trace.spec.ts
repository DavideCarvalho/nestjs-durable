import { isSpanContextValid, trace } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
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

describe('a run with many events', () => {
  it('hashes its ids once, not once per event', async () => {
    vi.resetModules();
    const hashes = vi.fn();
    vi.doMock('node:crypto', async (importOriginal) => {
      const crypto = await importOriginal<typeof import('node:crypto')>();
      return {
        ...crypto,
        createHash: (algorithm: string) => {
          hashes(algorithm);
          return crypto.createHash(algorithm);
        },
      };
    });
    const fresh = await import('./durable-run-trace');
    const first = fresh.runTraceId('wide-run');
    for (let event = 0; event < 1000; event += 1) {
      expect(fresh.runTraceId('wide-run')).toBe(first);
      fresh.runTraceContext('wide-run');
    }
    expect(hashes).toHaveBeenCalledTimes(2); // the trace id and the root span id
    // Still the same pure function of the run id: an evicted run hashes back to the same ids.
    for (let run = 0; run < 1000; run += 1) fresh.runTraceId(`other-${run}`);
    expect(fresh.runTraceId('wide-run')).toBe(first);
    expect(first).toBe(runTraceId('wide-run'));
    vi.doUnmock('node:crypto');
  });
});
