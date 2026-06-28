import { describe, expect, it } from 'vitest';
import { parseHeartbeatValue } from './bullmq-transport';

describe('parseHeartbeatValue — backward-compatible heartbeat reads', () => {
  it('reads the new {ts,status} JSON form (newer SDKs)', () => {
    const status = {
      runtime: 'node' as const,
      concurrency: { mode: 'adaptive' as const, limit: 4, min: 1, max: 32 },
      inFlight: 2,
    };
    const parsed = parseHeartbeatValue(JSON.stringify({ ts: 1_700_000_000_000, status }));
    expect(parsed.lastBeatAt).toBe(1_700_000_000_000);
    expect(parsed.status).toEqual(status);
  });

  it('reads an old bare-millisecond timestamp (old TS SDK) with no status', () => {
    const parsed = parseHeartbeatValue('1700000000000');
    expect(parsed.lastBeatAt).toBe(1_700_000_000_000);
    expect(parsed.status).toBeUndefined();
  });

  it('normalises a bare-seconds timestamp (old Python SDK) to ms', () => {
    const parsed = parseHeartbeatValue('1700000000');
    expect(parsed.lastBeatAt).toBe(1_700_000_000_000);
    expect(parsed.status).toBeUndefined();
  });

  it('normalises a seconds `ts` inside the JSON form to ms', () => {
    const parsed = parseHeartbeatValue(
      JSON.stringify({
        ts: 1_700_000_000,
        status: { concurrency: { mode: 'fixed', limit: 1 }, inFlight: 0 },
      }),
    );
    expect(parsed.lastBeatAt).toBe(1_700_000_000_000);
    expect(parsed.status).toBeDefined();
  });

  it('is robust to null / empty / garbled values', () => {
    expect(parseHeartbeatValue(null)).toEqual({ lastBeatAt: 0 });
    expect(parseHeartbeatValue('')).toEqual({ lastBeatAt: 0 });
    expect(parseHeartbeatValue('{not json')).toEqual({ lastBeatAt: 0 });
  });
});
