import { describe, expect, it } from 'vitest';
import { toBrokerPriority } from './bullmq-transport';

describe('toBrokerPriority — maps the lib "higher wins" scale onto BullMQ "lower wins"', () => {
  it('returns undefined for an absent priority (keeps the FIFO default path)', () => {
    expect(toBrokerPriority(undefined)).toBeUndefined();
  });

  it('maps a higher lib priority to a lower BullMQ number (more urgent)', () => {
    const urgent = toBrokerPriority(9);
    const normalish = toBrokerPriority(3);
    expect(urgent).toBeDefined();
    expect(normalish).toBeDefined();
    expect(urgent as number).toBeLessThan(normalish as number);
  });

  it('clamps into BullMQ valid range [1, 2097151]', () => {
    expect(toBrokerPriority(10_000_000)).toBe(1);
    expect(toBrokerPriority(-10_000_000)).toBe(2_097_151);
  });

  it('rounds non-integer priorities to a valid integer', () => {
    expect(Number.isInteger(toBrokerPriority(2.7))).toBe(true);
  });
});
