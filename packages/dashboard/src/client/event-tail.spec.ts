import { describe, expect, it, vi } from 'vitest';
import { EventTail } from './event-tail';

describe('EventTail', () => {
  it('keeps the last `limit` events and tells subscribers on each push', () => {
    const tail = new EventTail(2);
    const listener = vi.fn();
    const off = tail.subscribe(listener);
    const before = tail.snapshot();

    for (const seq of [1, 2, 3]) {
      tail.push({ type: 'step.completed', runId: 'r', seq, at: '2026-11-04T00:00:00.000Z' });
    }

    expect(tail.snapshot().map((t) => [t.id, t.event.seq])).toEqual([
      [2, 2],
      [3, 3],
    ]);
    expect(tail.snapshot()).toBe(tail.snapshot());
    expect(before).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    tail.push({ type: 'run.completed', runId: 'r', at: '2026-11-04T00:00:01.000Z' });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
