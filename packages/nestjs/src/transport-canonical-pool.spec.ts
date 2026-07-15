import {
  InMemoryStateStore,
  InMemoryTransport,
  TRANSPORT_CANONICAL,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DurableModule } from './durable.module';

describe('TRANSPORT_CANONICAL with a transports pool', () => {
  it('falls back to the pool primary when only `transports` (plural) is configured', async () => {
    // Feeding the step registrar / in-app worker: previously this resolved strictly from the
    // singular `transport`, so a pool-only operator registered NO step handlers and its own steps
    // parked in `wait` with no consumer.
    const primary = new InMemoryTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transports: [{ id: 'default', transport: primary }],
          topology: { role: 'control-plane' },
        }),
      ],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(TRANSPORT_CANONICAL, { strict: false })).toBe(primary);

    await moduleRef.close();
  });
});
