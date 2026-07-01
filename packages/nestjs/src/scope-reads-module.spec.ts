import {
  InMemoryStateStore,
  STATE_STORE_CANONICAL,
  type StateStore,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DurableModule } from './durable.module';

/**
 * A store that carries the `withScope` capability (like the MikroORM adapter). `withScope` returns a
 * NEW store tagged with the requested namespace, so a test can prove the module asked for a scoped
 * view rather than reusing the operator (unscoped) instance.
 */
class ScopeAwareStore extends InMemoryStateStore {
  readonly scopedTo: string | undefined;

  constructor(scopedTo?: string) {
    super();
    this.scopedTo = scopedTo;
  }

  withScope(scope: { namespace?: string }): StateStore {
    return new ScopeAwareStore(scope.namespace);
  }
}

describe('DurableModule — scopeReads option', () => {
  it('scopeReads:true + namespace re-scopes a capable store to that namespace', async () => {
    const store = new ScopeAwareStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, namespace: 'tenant-a', scopeReads: true })],
    }).compile();
    await moduleRef.init();

    const resolved = moduleRef.get<ScopeAwareStore>(STATE_STORE_CANONICAL, { strict: false });
    // Not the original operator store — a scoped view derived via withScope('tenant-a').
    expect(resolved).not.toBe(store);
    expect(resolved.scopedTo).toBe('tenant-a');

    await moduleRef.close();
  });

  it('defaults to unscoped — without scopeReads the operator store is used as-is', async () => {
    const store = new ScopeAwareStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, namespace: 'tenant-a' })],
    }).compile();
    await moduleRef.init();

    const resolved = moduleRef.get<ScopeAwareStore>(STATE_STORE_CANONICAL, { strict: false });
    // scopeReads off → the exact instance passed in (all namespaces visible).
    expect(resolved).toBe(store);

    await moduleRef.close();
  });

  it('a non-scopeable store is used as-is even with scopeReads:true (documented constraint)', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, namespace: 'tenant-a', scopeReads: true })],
    }).compile();
    await moduleRef.init();

    const resolved = moduleRef.get<InMemoryStateStore>(STATE_STORE_CANONICAL, { strict: false });
    expect(resolved).toBe(store);

    await moduleRef.close();
  });
});
