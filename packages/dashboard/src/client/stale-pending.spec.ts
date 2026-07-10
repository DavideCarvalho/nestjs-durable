import { describe, expect, it } from 'vitest';
import { STALE_PENDING_MS, type StepCheckpoint, isStalePending } from './durable-client';

function step(over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'r1',
    seq: 0,
    name: 'render',
    kind: 'remote',
    status: 'pending',
    attempts: 1,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('isStalePending', () => {
  const dispatchedAt = new Date('2026-01-01T00:00:00Z').getTime();

  it('is true for a remote+pending checkpoint older than STALE_PENDING_MS', () => {
    const cp = step({ enqueuedAt: '2026-01-01T00:00:00Z' });
    expect(isStalePending(cp, dispatchedAt + STALE_PENDING_MS + 1)).toBe(true);
  });

  it('is false for a fresh remote+pending checkpoint', () => {
    const cp = step({ enqueuedAt: '2026-01-01T00:00:00Z' });
    expect(isStalePending(cp, dispatchedAt + STALE_PENDING_MS - 1)).toBe(false);
  });

  it('is false for a non-remote checkpoint (e.g. local/sleep/signal)', () => {
    const cp = step({ kind: 'local', enqueuedAt: '2026-01-01T00:00:00Z' });
    expect(isStalePending(cp, dispatchedAt + STALE_PENDING_MS + 1)).toBe(false);
  });

  it('is false for a completed checkpoint', () => {
    const cp = step({ status: 'completed', enqueuedAt: '2026-01-01T00:00:00Z' });
    expect(isStalePending(cp, dispatchedAt + STALE_PENDING_MS + 1)).toBe(false);
  });

  it('falls back to startedAt when enqueuedAt is absent', () => {
    const cp = step({ startedAt: '2026-01-01T00:00:00Z' });
    expect(isStalePending(cp, dispatchedAt + STALE_PENDING_MS + 1)).toBe(true);
    expect(isStalePending(cp, dispatchedAt + STALE_PENDING_MS - 1)).toBe(false);
  });
});
