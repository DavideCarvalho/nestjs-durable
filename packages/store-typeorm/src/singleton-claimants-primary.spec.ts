import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { TypeOrmStateStore } from './typeorm-state-store';

describe('singleton claimant read', () => {
  it('reads on the primary and releases the runner', async () => {
    const find = vi.fn(async () => []);
    const release = vi.fn(async () => undefined);
    const createQueryRunner = vi.fn(() => ({
      manager: { getRepository: () => ({ find }) },
      release,
    }));
    const dataSource = {
      options: { type: 'postgres' },
      createQueryRunner,
      transaction: vi.fn(async () => false),
    } as unknown as DataSource;
    await new TypeOrmStateStore(dataSource).tryAdmitSingleton('r', 'singleton:k', 'wf', 1);
    expect(createQueryRunner).toHaveBeenCalledWith('master');
    expect(find).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
