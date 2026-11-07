import { describe, expect, it } from 'vitest';
import { supports } from './capabilities';

describe('supports()', () => {
  it('treats a missing topology, missing capabilities or a missing key as supported', () => {
    expect(supports(undefined, 'breakpoints')).toBe(true);
    expect(supports({ role: 'control-plane' }, 'breakpoints')).toBe(true);
    expect(supports({ role: 'control-plane', capabilities: {} }, 'workers')).toBe(true);
  });

  it('hides only what the server marks false', () => {
    const topology = {
      role: 'control-plane' as const,
      capabilities: { breakpoints: false, workers: true },
    };
    expect(supports(topology, 'breakpoints')).toBe(false);
    expect(supports(topology, 'workers')).toBe(true);
  });
});
