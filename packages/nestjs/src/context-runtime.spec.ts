import { Context, ContextModule } from '@dudousxd/nestjs-context';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, describe, expect, it } from 'vitest';
import type { ContextAccessor, TenantRef } from './context-accessor';
import { carrierFromContext, contextHasCustomSerialize } from './context-runtime';

afterAll(() => Context.resetConfig());

const tenant: TenantRef = { id: 'acme', kind: 'company', source: 'header' };
const accessor: ContextAccessor = {
  traceId: () => 't',
  tenantId: () => 'acme',
  userRef: () => ({ type: 'user', id: 1 }),
  get: () => undefined,
  tenant: () => tenant,
};

describe('carrierFromContext — the auto-fed carrier', () => {
  it('is what nestjs-context serializes, plus the full tenant when the allowlist lets tenantId through', () => {
    const serialize = () => ({ traceId: 't', tenantId: 'acme', userRef: undefined });
    expect(carrierFromContext(accessor, serialize, false)).toEqual({
      traceId: 't',
      tenantId: 'acme',
      tenant,
    });
  });

  it('adds no tenant when the allowlist leaves tenantId out', () => {
    expect(carrierFromContext(accessor, () => ({ traceId: 't' }), false)).toEqual({ traceId: 't' });
  });

  it("is exactly a custom serialize's output: no tenant added from the live accessor", () => {
    const serialize = () => ({ traceId: 't', tenantId: 'acme' });
    expect(carrierFromContext(accessor, serialize, true)).toEqual({
      traceId: 't',
      tenantId: 'acme',
    });
  });

  it("reads an app's own accessor directly when nestjs-context's serialize is not in play", () => {
    expect(carrierFromContext(accessor, undefined, false)).toEqual({
      traceId: 't',
      tenantId: 'acme',
      tenant,
      userRef: { type: 'user', id: 1 },
    });
  });
});

describe('contextHasCustomSerialize', () => {
  it('reads whether ContextModule.forRoot was given its own serialize', async () => {
    const custom = ContextModule.forRoot({
      autoMiddleware: false,
      serialize: (store) => ({ traceId: store.traceId }),
    });
    for (const [imports, expected] of [
      [[custom], true],
      [[ContextModule.forRoot({ autoMiddleware: false, carrier: ['traceId'] })], false],
      [[], false],
    ] as const) {
      const moduleRef = await Test.createTestingModule({ imports: [...imports] }).compile();
      expect(contextHasCustomSerialize(moduleRef.get(ModuleRef))).toBe(expected);
      await moduleRef.close();
      Context.resetConfig();
    }
  });
});
