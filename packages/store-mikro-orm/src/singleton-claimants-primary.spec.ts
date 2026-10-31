import type { MikroORM } from '@mikro-orm/core';
import { describe, expect, it, vi } from 'vitest';
import { MikroOrmStateStore } from './mikro-orm-state-store';

describe('singleton claimant read', () => {
  it('reads on the primary', async () => {
    class PostgreSqlPlatform {}
    const find = vi.fn(async () => []);
    const em = {
      setFilterParams: vi.fn(),
      getPlatform: () => new PostgreSqlPlatform(),
      find,
      transactional: vi.fn(async () => false),
    };
    const orm = { em: { fork: () => em } } as unknown as MikroORM;
    await new MikroOrmStateStore(orm).tryAdmitSingleton('r', 'singleton:k', 'wf', 1);
    expect(find.mock.calls[0]?.[2]).toMatchObject({ connectionType: 'write' });
  });
});
