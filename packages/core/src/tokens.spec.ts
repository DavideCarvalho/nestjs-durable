import { describe, expect, it } from 'vitest';
import { DURABLE_OPTIONS_CANONICAL, STATE_STORE_CANONICAL, TRANSPORT_CANONICAL } from './tokens';

/**
 * The DI tokens MUST live in the global symbol registry (`Symbol.for`), not be plain `Symbol()`.
 *
 * A process can hold more than one physical copy of `core`: pnpm peer-dependency multiplexing
 * installs a separate virtual copy per distinct peer set, and the dual ESM/CJS build can be loaded
 * once via `import` (`index.js`) and once via `require` (`index.cjs`). A plain `Symbol()` mints a
 * distinct token per evaluation, so `DurableModule` (provider) and an injector in another package
 * (e.g. the dashboard's `DashboardService`, a store adapter) would resolve different symbols and
 * Nest would fail with "<token> is not available in the ... context". A registered symbol collapses
 * every copy to one identity. If anyone reverts these to `Symbol()`, this test fails.
 */
describe('DI tokens', () => {
  it('are registered in the global symbol registry', () => {
    expect(Symbol.keyFor(STATE_STORE_CANONICAL)).toBe('@dudousxd/nestjs-durable:state-store');
    expect(Symbol.keyFor(TRANSPORT_CANONICAL)).toBe('@dudousxd/nestjs-durable:transport');
    expect(Symbol.keyFor(DURABLE_OPTIONS_CANONICAL)).toBe('@dudousxd/nestjs-durable:options');
  });

  it('resolve to the same instance a second copy of core would mint', () => {
    // Simulates the token a second, independently-evaluated copy of `core` produces.
    expect(Symbol.for('@dudousxd/nestjs-durable:state-store')).toBe(STATE_STORE_CANONICAL);
    expect(Symbol.for('@dudousxd/nestjs-durable:transport')).toBe(TRANSPORT_CANONICAL);
    expect(Symbol.for('@dudousxd/nestjs-durable:options')).toBe(DURABLE_OPTIONS_CANONICAL);
  });
});
