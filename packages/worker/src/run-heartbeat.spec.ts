import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRunHeartbeat } from './redis-runner';
import { heartbeatChannel } from './runner-core';

// The run-scoped liveness heartbeat: while a workflow worker replays a turn it publishes a beat on
// `<prefix>-heartbeat` keyed by `runId` (NO stepId), so the engine rearms the run's `advance`
// deadline and never wrongly re-drives a worker that's alive-but-slow. These tests drive the pure,
// injectable beat loop with a publish spy + fake timers — deterministic, no Redis.

/** A minimal publish client recording every `(channel, payload)` it's handed. */
function makePublisher() {
  const calls: Array<{ channel: string; payload: string }> = [];
  return {
    calls,
    client: {
      publish: vi.fn(async (channel: string, payload: string) => {
        calls.push({ channel, payload });
        return 1;
      }),
    },
  };
}

describe('startRunHeartbeat (run-scoped liveness beat)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('publishes an immediate beat on <prefix>-heartbeat with {runId, seq:0, group} (no stepId)', () => {
    const pub = makePublisher();
    const stop = startRunHeartbeat(pub.client, 'durable', 'wf', 'run-1');

    expect(pub.calls).toHaveLength(1);
    expect(pub.calls[0]?.channel).toBe('durable-heartbeat');
    expect(pub.calls[0]?.channel).toBe(heartbeatChannel('durable'));
    expect(JSON.parse(pub.calls[0]?.payload ?? '{}')).toEqual({
      runId: 'run-1',
      seq: 0,
      group: 'wf',
    });
    // run-scoped beats omit stepId entirely (engine keys the reset by runId when stepId is absent)
    expect(JSON.parse(pub.calls[0]?.payload ?? '{}')).not.toHaveProperty('stepId');

    stop();
  });

  it('keeps beating on a 5s interval while the turn runs', () => {
    const pub = makePublisher();
    const stop = startRunHeartbeat(pub.client, 'durable', 'wf', 'run-1');
    expect(pub.calls).toHaveLength(1); // immediate

    vi.advanceTimersByTime(5_000);
    expect(pub.calls).toHaveLength(2);
    vi.advanceTimersByTime(10_000);
    expect(pub.calls).toHaveLength(4);

    stop();
  });

  it('stops beating once the returned stop() is called (interval cleared)', () => {
    const pub = makePublisher();
    const stop = startRunHeartbeat(pub.client, 'durable', 'wf', 'run-1');
    stop();
    const after = pub.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(pub.calls).toHaveLength(after);
  });

  it('honours a custom prefix', () => {
    const pub = makePublisher();
    const stop = startRunHeartbeat(pub.client, 'app', 'g', 'run-1');
    expect(pub.calls[0]?.channel).toBe('app-heartbeat');
    stop();
  });

  it('a throwing publish never throws out of the beat (best-effort)', () => {
    const client = {
      publish: vi.fn(() => {
        throw new Error('redis down');
      }),
    };
    expect(() => {
      const stop = startRunHeartbeat(client, 'durable', 'wf', 'run-1');
      vi.advanceTimersByTime(5_000);
      stop();
    }).not.toThrow();
  });

  it('is a no-op (and stop is safe) when no client is available', () => {
    expect(() => {
      const stop = startRunHeartbeat(undefined, 'durable', 'wf', 'run-1');
      vi.advanceTimersByTime(10_000);
      stop();
    }).not.toThrow();
  });
});
