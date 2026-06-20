import { assertCapabilityNaming, capability } from '@dudousxd/nestjs-diagnostics';
import { describe, expect, it } from 'vitest';
import { DURABLE_OPTIONS_CANONICAL, STATE_STORE_CANONICAL, TRANSPORT_CANONICAL } from './tokens';

describe('durable canonical capability tokens', () => {
  it("equal capability('durable', <name>) — cross-lib resolvable", () => {
    expect(STATE_STORE_CANONICAL).toBe(capability('durable', 'state-store'));
    expect(TRANSPORT_CANONICAL).toBe(capability('durable', 'transport'));
    expect(DURABLE_OPTIONS_CANONICAL).toBe(capability('durable', 'options'));
  });

  it('follow the canonical @dudousxd/nestjs-durable: naming', () => {
    expect(() =>
      assertCapabilityNaming('durable', {
        STATE_STORE_CANONICAL,
        TRANSPORT_CANONICAL,
        DURABLE_OPTIONS_CANONICAL,
      }),
    ).not.toThrow();
  });
});
