import {
  DURABLE_OPTIONS,
  DURABLE_OPTIONS_CANONICAL,
  InMemoryStateStore,
  STATE_STORE,
  STATE_STORE_CANONICAL,
  TRANSPORT,
  TRANSPORT_CANONICAL,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DurableModule } from './durable.module';

describe('DurableModule — dual-bind canonical token aliases', () => {
  it('canonical STATE_STORE_CANONICAL resolves the same instance as legacy STATE_STORE', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store })],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(STATE_STORE_CANONICAL, { strict: false })).toBe(
      moduleRef.get(STATE_STORE, { strict: false }),
    );

    await moduleRef.close();
  });

  it('canonical TRANSPORT_CANONICAL resolves the same instance as legacy TRANSPORT', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store })],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(TRANSPORT_CANONICAL, { strict: false })).toBe(
      moduleRef.get(TRANSPORT, { strict: false }),
    );

    await moduleRef.close();
  });

  it('canonical DURABLE_OPTIONS_CANONICAL resolves the same instance as legacy DURABLE_OPTIONS', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store })],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(DURABLE_OPTIONS_CANONICAL, { strict: false })).toBe(
      moduleRef.get(DURABLE_OPTIONS, { strict: false }),
    );

    await moduleRef.close();
  });
});
