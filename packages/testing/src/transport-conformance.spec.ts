import { InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { assertTransportConformance } from './transport-conformance';

describe('assertTransportConformance', () => {
  it('passes for the in-memory transport (the reference implementation)', async () => {
    await expect(assertTransportConformance(new InMemoryTransport())).resolves.toBeUndefined();
  });
});
