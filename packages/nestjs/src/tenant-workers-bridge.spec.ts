import {
  DURABLE_OPTIONS_CANONICAL,
  InMemoryStateStore,
  InMemoryTransport,
  TRANSPORT_CANONICAL,
  type Transport,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DurableModule, type DurableModuleOptions } from './durable.module';

/** An InMemoryTransport that can derive a namespace-pinned sibling (the `withNamespace` seam the
 *  bridge preset requires — BullMQTransport implements the real one). */
class SiblingCapableTransport extends InMemoryTransport {
  readonly pinnedNamespace: string | undefined;
  constructor(pinnedNamespace?: string) {
    super();
    this.pinnedNamespace = pinnedNamespace;
  }
  withNamespace(namespace: string): Transport {
    return new SiblingCapableTransport(namespace);
  }
}

async function resolvedOptions(
  options: Parameters<typeof DurableModule.forRoot>[0],
): Promise<{ options: DurableModuleOptions; canonical: unknown; close: () => Promise<void> }> {
  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot(options)],
  }).compile();
  await moduleRef.init();
  return {
    options: moduleRef.get(DURABLE_OPTIONS_CANONICAL, { strict: false }),
    canonical: moduleRef.get(TRANSPORT_CANONICAL, { strict: false }),
    close: () => moduleRef.close(),
  };
}

describe("control-plane preset — tenantWorkers: 'bridge'", () => {
  it('with a tenant: pairs the transport with a bare-prefix sibling, keeping it as canonical', async () => {
    const primary = new SiblingCapableTransport();
    const { options, canonical, close } = await resolvedOptions({
      store: new InMemoryStateStore(),
      transport: primary,
      topology: { role: 'control-plane', tenant: 'dev-alice', tenantWorkers: 'bridge' },
    });

    expect(options.namespace).toBe('dev-alice'); // tenant still maps onto namespace
    expect(options.transports).toHaveLength(2);
    expect(options.transports?.[0]?.transport).toBe(primary);
    const sibling = options.transports?.[1]?.transport as SiblingCapableTransport;
    expect(sibling.pinnedNamespace).toBe('default'); // bare-prefix sibling, explicitly pinned
    // The singular transport still feeds the step registrar / in-app worker.
    expect(canonical).toBe(primary);

    await close();
  });

  it('without a tenant: the bridge is INERT (safe on a static config reading tenant from env)', async () => {
    const primary = new SiblingCapableTransport();
    const { options, canonical, close } = await resolvedOptions({
      store: new InMemoryStateStore(),
      transport: primary,
      topology: { role: 'control-plane', tenant: undefined, tenantWorkers: 'bridge' },
    });

    expect(options.namespace).toBeUndefined(); // global operator
    expect(options.transports).toBeUndefined(); // no pool built
    expect(canonical).toBe(primary);

    await close();
  });

  it('an explicit `transports` pool wins over the sugar (hand-wired bridge untouched)', async () => {
    const primary = new SiblingCapableTransport();
    const bare = new SiblingCapableTransport('default');
    const { options, close } = await resolvedOptions({
      store: new InMemoryStateStore(),
      transport: primary,
      transports: [
        { id: 'default', transport: primary },
        { id: 'tenant-workers', transport: bare },
      ],
      topology: { role: 'control-plane', tenant: 'dev-alice', tenantWorkers: 'bridge' },
    });

    expect(options.transports).toHaveLength(2);
    expect(options.transports?.[1]?.transport).toBe(bare);

    await close();
  });

  it('a transport without `withNamespace` cannot be bridged — config error, not a silent no-op', () => {
    expect(() =>
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new InMemoryTransport(), // no withNamespace
        topology: { role: 'control-plane', tenant: 'dev-alice', tenantWorkers: 'bridge' },
      }),
    ).toThrow(/withNamespace/);
  });

  it('TRANSPORT_CANONICAL falls back to the pool primary when only `transports` is configured', async () => {
    const primary = new SiblingCapableTransport();
    const { canonical, close } = await resolvedOptions({
      store: new InMemoryStateStore(),
      transports: [{ id: 'default', transport: primary }],
      topology: { role: 'control-plane' },
    });

    expect(canonical).toBe(primary);

    await close();
  });
});
