import { encodeInstanceRecord as encodeRunnerRecord } from '@dudousxd/durable-worker';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from './bullmq-transport';
import { encodeInstanceRecord } from './worker-registry';

/**
 * The worker registry over a real Redis: the instances hash (`<prefix>-workers:instances`, the
 * AdonisJS durable lib's layout), the keys written for older readers, the compatibility walk, reads
 * without SCAN, and the clean removal on close. Uses `DURABLE_TEST_REDIS_URL` when set, else a
 * testcontainers Redis; skipped when neither is available.
 */
const externalUrl = process.env.DURABLE_TEST_REDIS_URL;
let container: StartedRedisContainer | undefined;
let connection: { host: string; port: number } | undefined;

beforeAll(async () => {
  try {
    if (externalUrl) {
      const u = new URL(externalUrl);
      connection = { host: u.hostname, port: Number(u.port || 6379) };
      return;
    }
    if (process.env.SKIP_TESTCONTAINERS) return;
    container = await new RedisContainer('redis:7-alpine').start();
    connection = { host: container.getHost(), port: container.getFirstMappedPort() };
  } catch {
    connection = undefined;
  }
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition was never met');
}

/** Count the SCAN commands `client` sends, through MONITOR on a side connection. */
async function countScans(
  conn: { host: string; port: number },
  run: () => Promise<void>,
): Promise<number> {
  const monitorClient = new Redis(conn);
  const monitor = await monitorClient.monitor();
  let scans = 0;
  monitor.on('monitor', (_time: string, args: string[]) => {
    if (String(args[0]).toLowerCase() === 'scan') scans++;
  });
  try {
    await run();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    monitor.disconnect();
    monitorClient.disconnect();
  }
  return scans;
}

describe('BullMQ worker registry (real Redis)', () => {
  it('advertises in one hash field per instance, next to the keys older readers read', async (ctx) => {
    if (!connection) return ctx.skip();
    const prefix = `durreg-${Date.now()}-a`;
    const admin = new Redis(connection);
    const worker = new BullMQTransport({ connection, prefix, instanceId: 'ts-worker' });
    const engine = new BullMQTransport({ connection, prefix, instanceId: 'ts-engine' });
    worker.handle('reg.charge', async () => ({}));
    worker.handle('reg.mail', async () => ({}));

    await waitUntil(
      async () => Object.keys(await admin.hgetall(`${prefix}-workers:instances`)).length === 1,
    );
    const fields = await admin.hgetall(`${prefix}-workers:instances`);
    const [field] = Object.keys(fields);
    expect(field).toMatch(/^ts-worker#[0-9a-f]{8}$/);
    const record = JSON.parse(fields[field as string] as string);
    expect(record).toMatchObject({ v: 1, instance: 'ts-worker' });
    expect(record.expiresAt).toBeGreaterThan(Date.now());
    expect(record.heartbeats).toHaveLength(1);
    expect(record.heartbeats[0].tokens.sort()).toEqual(['reg.charge', 'reg.mail']);
    expect(record.descriptors[0].tokens.sort()).toEqual(['reg.charge', 'reg.mail']);
    expect(await admin.pttl(`${prefix}-workers:instances`)).toBeGreaterThan(0);

    // Older readers' keys: the per-instance keys and the per-token hashes with their index.
    await waitUntil(
      async () => (await admin.exists(`${prefix}-worker-heartbeat:reg.mail:ts-worker`)) === 1,
    );
    expect(await admin.get(`${prefix}-worker-descriptor:reg.charge:ts-worker`)).not.toBeNull();
    const tokenHash = await admin.hgetall(`${prefix}-workers:heartbeats:reg.charge`);
    expect(Object.keys(tokenHash)).toEqual(['ts-worker']);
    expect(JSON.parse(tokenHash['ts-worker'] as string).expiresAt).toBeGreaterThan(Date.now());
    expect((await admin.zrange(`${prefix}-workers:tokens`, 0, -1)).sort()).toEqual([
      'reg.charge',
      'reg.mail',
    ]);

    expect((await engine.listWorkerGroups()).sort()).toEqual(['reg.charge', 'reg.mail']);
    expect((await engine.groupHealth('reg.mail')).liveWorkers.map((w) => w.instanceId)).toEqual([
      'ts-worker',
    ]);
    expect((await engine.readWorkerDescriptors('reg.charge')).map((d) => d.instanceId)).toEqual([
      'ts-worker',
    ]);

    await worker.close();
    expect(await admin.hgetall(`${prefix}-workers:instances`)).toEqual({});
    expect(await admin.get(`${prefix}-worker-heartbeat:reg.charge:ts-worker`)).toBeNull();
    expect(await admin.hgetall(`${prefix}-workers:heartbeats:reg.charge`)).toEqual({});
    expect(await admin.hgetall(`${prefix}-workers:descriptors:reg.charge`)).toEqual({});
    await engine.close();
    await admin.quit();
  }, 30_000);

  it('reads an AdonisJS field and a Python per-instance key; legacy off reads without SCAN', async (ctx) => {
    if (!connection) return ctx.skip();
    const prefix = `durreg-${Date.now()}-b`;
    const admin = new Redis(connection);
    const now = Date.now();
    // An AdonisJS worker's field, as its transport encodes it.
    await admin.hset(
      `${prefix}-workers:instances`,
      'adonis-1#abcd1234',
      JSON.stringify({
        v: 1,
        instance: 'adonis-1',
        expiresAt: now + 35_000,
        heartbeats: [
          { value: JSON.stringify({ ts: now }), expiresAt: now + 35_000, tokens: ['ad.render'] },
        ],
        descriptors: [
          {
            value: JSON.stringify({ instanceId: 'adonis-1' }),
            expiresAt: now + 35_000,
            tokens: ['ad.render'],
          },
        ],
      }),
    );
    // An expired field of a crashed writer is not read.
    await admin.hset(
      `${prefix}-workers:instances`,
      'gone-1#00000000',
      encodeInstanceRecord([
        { instance: 'gone-1', kind: 'heartbeats', token: 'gone', value: '1', expiresAt: now - 1 },
      ]),
    );
    // A Python worker: only its per-instance key.
    await admin.set(`${prefix}-worker-heartbeat:py.step:py-1`, String(now / 1000), 'EX', 35);

    const withWalk = new BullMQTransport({ connection, prefix, instanceId: 'ts-a' });
    expect((await withWalk.listWorkerGroups()).sort()).toEqual(['ad.render', 'py.step']);
    expect((await withWalk.readAllWorkerDescriptors()).map((d) => d.instanceId)).toEqual([
      'adonis-1',
    ]);

    const noWalk = new BullMQTransport({
      connection,
      prefix,
      instanceId: 'ts-b',
      workerRegistry: { legacyScan: false, legacyWrites: false },
    });
    let groups: string[] = [];
    const scans = await countScans(connection, async () => {
      groups = await noWalk.listWorkerGroups();
      await noWalk.readAllWorkerHeartbeats();
      await noWalk.groupHealth('ad.render');
    });
    expect(groups).toEqual(['ad.render']);
    expect(scans).toBe(0);

    await withWalk.close();
    await noWalk.close();
    await admin.quit();
  }, 30_000);

  it('the compatibility walk runs at most once per interval, however many readers', async (ctx) => {
    if (!connection) return ctx.skip();
    const prefix = `durreg-${Date.now()}-c`;
    const reader = new BullMQTransport({ connection, prefix, instanceId: 'ts-r' });
    const scans = await countScans(connection, async () => {
      for (let i = 0; i < 20; i++) {
        await Promise.all([
          reader.listWorkerGroups(),
          reader.readAllWorkerDescriptors(),
          reader.readWorkerDescriptors('x', { fresh: true }),
          reader.readAllWorkerHeartbeats(),
        ]);
      }
    });
    // One walk of a near-empty db is one SCAN call.
    expect(scans).toBe(1);
    await reader.close();
  }, 30_000);

  it('legacyWrites: false leaves one hash field per instance, removed on close', async (ctx) => {
    if (!connection) return ctx.skip();
    const prefix = `durreg-${Date.now()}-d`;
    const admin = new Redis(connection);
    const registry = { legacyWrites: false, legacyScan: false };
    const worker = new BullMQTransport({
      connection,
      prefix,
      instanceId: 'ts-worker',
      workerRegistry: registry,
    });
    for (let i = 0; i < 20; i += 1) worker.handle(`reg.step${i}`, async () => ({}));
    const stopRuns = worker.onDispatchedRun(async () => undefined, { concurrency: 2 });
    await waitUntil(
      async () => Object.keys(await admin.hgetall(`${prefix}-workers:instances`)).length === 1,
    );
    expect(await admin.keys(`${prefix}-*`)).toEqual([`${prefix}-workers:instances`]);

    const reader = new BullMQTransport({
      connection,
      prefix,
      instanceId: 'ts-reader',
      workerRegistry: registry,
    });
    expect((await reader.listWorkerGroups()).length).toBe(20);
    // A run consumer is listed as one, never as a worker group.
    expect((await reader.liveRunConsumers()).map((c) => c.instanceId)).toEqual(['ts-worker']);
    expect(await reader.listWorkerGroups()).not.toContain(`${prefix}-runs`);

    await stopRuns();
    await worker.close();
    expect(await admin.hgetall(`${prefix}-workers:instances`)).toEqual({});
    await reader.close();
    await admin.quit();
  }, 30_000);

  it('a field written by @dudousxd/durable-worker decodes like the transport encodes it', () => {
    const entries = [
      { kind: 'heartbeats' as const, token: 'a', value: 'hb', expiresAt: 5 },
      { kind: 'descriptors' as const, token: 'a', value: 'd', expiresAt: 5 },
      { kind: 'heartbeats' as const, token: 'b', value: 'hb', expiresAt: 7 },
    ];
    expect(encodeRunnerRecord('w-1', entries)).toBe(
      encodeInstanceRecord(entries.map((e) => ({ ...e, instance: 'w-1' }))),
    );
  });
});
