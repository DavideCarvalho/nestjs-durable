import { afterEach, describe, expect, it } from 'vitest';
import { withTenantLabels } from './tenant-labels.js';

const SLOT = Symbol.for('@dudousxd/nestjs-diagnostics:accessor');
const holder = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  delete holder[SLOT];
});

describe('withTenantLabels', () => {
  it('labels rows with a tenant through the context, one lookup per page', async () => {
    const asked: string[][] = [];
    holder[SLOT] = {
      current: {
        tenantLabels: async (tenants: Array<{ id: string }>) => {
          asked.push(tenants.map((t) => t.id));
          return Object.fromEntries(tenants.map((t) => [t.id, `Org ${t.id}`]));
        },
      },
    };
    const rows = await withTenantLabels([
      { id: 'r1', tenantId: 'o1', tenantKind: 'organization' },
      { id: 'r2', tenantId: 'o1', tenantKind: 'organization' },
      { id: 'r3', tenantId: 'o2' },
      { id: 'r4', tenantId: null },
      { id: 'r5' },
    ]);
    expect(asked).toEqual([['o1', 'o2']]);
    expect(rows.map((r) => (r as { tenantLabel?: string }).tenantLabel)).toEqual([
      'Org o1',
      'Org o1',
      'Org o2',
      undefined,
      undefined,
    ]);
  });

  it('falls back to the id without a context, or when its resolver fails', async () => {
    expect((await withTenantLabels([{ tenantId: 'o1' }]))[0]?.tenantLabel).toBe('o1');
    holder[SLOT] = {
      current: {
        tenantLabels: async () => {
          throw new Error('down');
        },
      },
    };
    expect((await withTenantLabels([{ tenantId: 'o1' }]))[0]?.tenantLabel).toBe('o1');
  });

  it('asks nothing for a page without tenants', async () => {
    const rows: Array<{ id: string; tenantId?: string }> = [{ id: 'r1' }];
    expect(await withTenantLabels(rows)).toBe(rows);
  });
});
