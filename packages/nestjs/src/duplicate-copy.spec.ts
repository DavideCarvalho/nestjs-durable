import { InMemoryStateStore, InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableModule } from './durable.module';
import { DuplicateDurableCopyError } from './index';

const KEY = Symbol.for('@dudousxd/nestjs-durable.copies');
const slot = globalThis as Record<symbol, unknown>;
const real = slot[KEY];

const A = { version: '0.93.0', root: '/app/node_modules/.pnpm/core_a/node_modules/core' };
const B = { version: '0.93.0', root: '/app/node_modules/.pnpm/core_b/node_modules/core' };

/** Swap in a registry that already saw two installs, as two pnpm peer variants would leave it. */
function twoCopiesLoaded() {
  slot[KEY] = {
    copies: new Map([
      [A.root, A],
      [B.root, B],
    ]),
    booted: false,
  };
}

afterEach(() => {
  slot[KEY] = real;
});

describe('DurableModule with two copies of the core package loaded', () => {
  it('forRoot throws DuplicateDurableCopyError naming both installs', () => {
    twoCopiesLoaded();
    const boot = () =>
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new InMemoryTransport(),
      });
    expect(boot).toThrow(DuplicateDurableCopyError);
    expect(boot).toThrow(A.root);
    expect(boot).toThrow(B.root);
  });

  it('forRootAsync throws too, before any factory runs', () => {
    twoCopiesLoaded();
    expect(() =>
      DurableModule.forRootAsync({
        useFactory: () => ({ store: new InMemoryStateStore(), transport: new InMemoryTransport() }),
      }),
    ).toThrow(DuplicateDurableCopyError);
  });

  it('boots with the single copy this process loaded', () => {
    expect(() =>
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new InMemoryTransport(),
      }),
    ).not.toThrow();
  });
});
