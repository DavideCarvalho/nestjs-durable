import * as core from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import * as facade from './index';

/**
 * The facade re-export block in `index.ts` mixes types and classes. Putting a CLASS in its
 * `export type { ... }` block is invisible to every other gate we have: `tsc` is green (the
 * `.d.ts` rollup drops the `type` modifier, so the name looks like a value export to consumers),
 * `tsup` is green, and nothing fails until a consumer uses the symbol as a value at runtime and
 * gets `undefined`.
 *
 * That shipped once: `RunGateway` (an abstract class that doubles as its own DI token) sat in the
 * `export type` block, so `ctx.get(RunGateway)` in a downstream app resolved `moduleRef.get(undefined)`
 * and threw "Nest could not find given element" — on the one code path that touched the gateway.
 */
describe('facade re-exports keep core classes as VALUES', () => {
  // Anything on core's public surface that is a class must survive into the bundle. Derived from
  // core itself rather than hard-coded, so a class added there is covered without editing this list.
  const coreClassNames = Object.keys(core).filter(
    (name) => typeof (core as Record<string, unknown>)[name] === 'function',
  );

  it('core exposes classes worth guarding (guards the guard)', () => {
    expect(coreClassNames).toContain('RunGateway');
  });

  it.each(['RunGateway', 'WorkflowEngine'])('%s is re-exported as a value, not a type', (name) => {
    const exported = (facade as Record<string, unknown>)[name];
    expect(
      exported,
      `${name} is undefined at runtime — moved into the \`export type\` block?`,
    ).toBeDefined();
    expect(exported).toBe((core as Record<string, unknown>)[name]);
  });

  it('RUN_GATEWAY and RunGateway are the same DI token', () => {
    // The alias is deprecated but still the token the module binds; the two must not drift, or
    // `@Inject(RUN_GATEWAY)` and `ctx.get(RunGateway)` resolve different providers.
    expect(facade.RUN_GATEWAY).toBe(facade.RunGateway);
    expect(facade.RUN_GATEWAY).toBe(core.RunGateway);
  });
});
