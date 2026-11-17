import { describe, expect, it, vi } from 'vitest';
import { RegistryWriter } from './worker-registry';

function fakeRedis(withHashes = true) {
  const keys = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const calls: string[] = [];
  const client = {
    set: vi.fn(async (key: string, value: string) => {
      calls.push(`set ${key}`);
      keys.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...ks: string[]) => {
      for (const k of ks) keys.delete(k);
      return ks.length;
    }),
    ...(withHashes
      ? {
          hset: vi.fn(async (key: string, field: string, value: string) => {
            calls.push(`hset ${key}`);
            const h = hashes.get(key) ?? new Map<string, string>();
            h.set(field, value);
            hashes.set(key, h);
            return 1;
          }),
          hgetall: vi.fn(async (key: string) => Object.fromEntries(hashes.get(key) ?? [])),
          hdel: vi.fn(async (key: string, ...fields: string[]) => {
            for (const f of fields) hashes.get(key)?.delete(f);
            return fields.length;
          }),
          pexpire: vi.fn(async () => 1),
        }
      : {}),
  };
  return { client, keys, hashes, calls };
}

const beat = (tokens: string[]) => ({
  tokens,
  heartbeat: '{"ts":1}',
  descriptor: '{"instanceId":"w-1"}',
  ttlSeconds: 35,
  heartbeatKey: (t: string) => `durable-worker-heartbeat:${t}:w-1`,
  descriptorKey: (t: string) => `durable-worker-descriptor:${t}:w-1`,
});

describe('RegistryWriter', () => {
  it('writes one field for every token, and the legacy keys once per interval', async () => {
    const { client, hashes, keys, calls } = fakeRedis();
    const writer = new RegistryWriter(client, 'durable', 'w-1');
    await writer.beat(beat(['a', 'b', 'c']));
    const field = [...(hashes.get('durable-workers:instances')?.entries() ?? [])];
    expect(field).toHaveLength(1);
    expect(field[0]?.[0]).toMatch(/^w-1#[0-9a-f]{8}$/);
    const record = JSON.parse(field[0]?.[1] ?? '{}');
    expect(record).toMatchObject({ v: 1, instance: 'w-1' });
    expect(record.heartbeats).toEqual([
      { value: '{"ts":1}', expiresAt: record.expiresAt, tokens: ['a', 'b', 'c'] },
    ]);
    expect(keys.size).toBe(6);

    calls.length = 0;
    await writer.beat(beat(['a', 'b', 'c']));
    // Within the legacy interval: one HSET, no SET.
    expect(calls).toEqual(['hset durable-workers:instances']);

    await writer.remove();
    expect(hashes.get('durable-workers:instances')?.size).toBe(0);
    expect(keys.size).toBe(0);
  });

  it('legacyWrites: false writes the field alone', async () => {
    const { client, keys } = fakeRedis();
    const writer = new RegistryWriter(client, 'durable', 'w-1', { legacyWrites: false });
    await writer.beat(beat(['a']));
    expect(keys.size).toBe(0);
  });

  it('a client without hash commands keeps writing the keys every beat', async () => {
    const { client, calls } = fakeRedis(false);
    const writer = new RegistryWriter(client, 'durable', 'w-1');
    await writer.beat(beat(['a']));
    await writer.beat(beat(['a']));
    expect(calls.filter((c) => c.startsWith('set'))).toHaveLength(4);
  });
});
