import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { runStateStoreContract } from '@dudousxd/nestjs-durable-testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaStateStore } from './prisma-state-store';

/**
 * Real-engine matrix for the Prisma adapter: the SHARED cross-store contract + the adapter's own
 * search-attribute / pushdown assertions, run against a real Postgres (testcontainers) instead of the
 * committed SQLite client. Run with `pnpm test:db`.
 *
 * Why this can't ride the committed client: the Prisma client is generated for ONE provider at a
 * time, and the committed one targets sqlite. So this spec generates a Postgres client (into a
 * separate, gitignored `generated/pg-client`) and `db push`es the durable schema against the
 * container at setup time. On Postgres, `array_contains` (the tag filter) and the numeric side-table
 * predicates behave as in production — hence `supportsTagFilter: true` here, vs the SQLite spec's
 * `false`.
 *
 * Setup runs `prisma generate` + `prisma db push` via the CLI. If Docker is unavailable, or the
 * generate/push fails (e.g. offline engine download), the whole suite skips cleanly — never fails the
 * build for missing infra. Set `SKIP_TESTCONTAINERS` to force-skip.
 */

const CONTAINER_TIMEOUT = 240_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;
const pkgRoot = resolve(__dirname, '..');

let pg: StartedPostgreSqlContainer | undefined;
let setupError: unknown;
// biome-ignore lint/suspicious/noExplicitAny: client is generated at test time, so untyped here.
let sharedPrisma: any;

function runPrisma(args: string[], env: Record<string, string>): void {
  execFileSync('npx', ['prisma', ...args], {
    cwd: pkgRoot,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
}

beforeAll(async () => {
  if (skipped) return;
  try {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    const url = pg.getConnectionUri();
    const schema = 'prisma/test.pg.prisma';
    // Generate the Postgres client into generated/pg-client, then create the tables.
    runPrisma(['generate', '--schema', schema], { PRISMA_PG_URL: url });
    runPrisma(['db', 'push', '--schema', schema, '--skip-generate', '--accept-data-loss'], {
      PRISMA_PG_URL: url,
    });
    const { PrismaClient } = await import('../generated/pg-client/index.js');
    sharedPrisma = new PrismaClient({ datasources: { db: { url } } });
    await sharedPrisma.$connect();
  } catch (err) {
    setupError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await sharedPrisma?.$disconnect?.();
  await pg?.stop();
});

async function truncatePrisma(): Promise<void> {
  await sharedPrisma.durableStepCheckpoint.deleteMany();
  await sharedPrisma.durableSignalWaiter.deleteMany();
  await sharedPrisma.durableBufferedSignal.deleteMany();
  await sharedPrisma.durableRunAttribute.deleteMany(); // before runs (FK)
  await sharedPrisma.durableWorkflowRun.deleteMany();
}

function available(): boolean {
  return !skipped && !setupError && !!sharedPrisma;
}

runStateStoreContract('Prisma (Postgres)', async () => {
  if (!available()) {
    throw new (await import('@dudousxd/nestjs-durable-testing')).StateStoreUnavailableError(
      skipped
        ? 'SKIP_TESTCONTAINERS set'
        : `Prisma Postgres unavailable (is Docker running?): ${String(setupError)}`,
    );
  }
  await truncatePrisma();
  return {
    store: new PrismaStateStore(sharedPrisma),
    // Postgres supports `array_contains`, so the tag filter is exercised here (unlike SQLite).
    supportsTagFilter: true,
    cleanup: async () => undefined,
  };
});

const at = new Date('2026-06-11T00:00:00.000Z');
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'r1',
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'running',
  input: { orderId: 'o1' },
  createdAt: at,
  updatedAt: at,
  ...over,
});
const checkpoint = (over: Partial<StepCheckpoint> = {}): StepCheckpoint => ({
  runId: 'r1',
  seq: 0,
  name: 'reserve',
  kind: 'local',
  stepId: 'r1:0',
  status: 'completed',
  output: { ok: true },
  attempts: 1,
  startedAt: at,
  finishedAt: at,
  ...over,
});

describe('PrismaStateStore [real Postgres / testcontainers]', () => {
  let store: PrismaStateStore;

  beforeEach(async (ctx) => {
    if (!available()) ctx.skip();
    await truncatePrisma();
    store = new PrismaStateStore(sharedPrisma);
  });

  it('persists a run with JSON input and reads it back', async () => {
    await store.createRun(run());
    const loaded = await store.getRun('r1');
    expect(loaded?.workflow).toBe('checkout');
    expect(loaded?.input).toEqual({ orderId: 'o1' });
  });

  it('upserts checkpoints and reads them by (runId, seq)', async () => {
    await store.createRun(run());
    await store.saveCheckpoint(checkpoint());
    await store.saveCheckpoint(
      checkpoint({ seq: 1, name: 'charge', output: { chargeId: 'ch_1' } }),
    );
    expect((await store.getCheckpoint('r1', 0))?.output).toEqual({ ok: true });
    expect((await store.getCheckpoint('r1', 1))?.name).toBe('charge');
    expect(await store.listCheckpoints('r1')).toHaveLength(2);
  });

  it('lists incomplete runs and due timers', async () => {
    await store.createRun(run({ id: 'running1', status: 'running' }));
    await store.createRun(run({ id: 'suspended1', status: 'suspended', wakeAt: 5_000 }));
    await store.createRun(run({ id: 'done1', status: 'completed' }));
    expect((await store.listIncompleteRuns()).map((r) => r.id)).toEqual(['running1']);
    expect((await store.listDueTimers(10_000)).map((r) => r.id)).toEqual(['suspended1']);
    expect(await store.listDueTimers(1_000)).toHaveLength(0);
  });

  it('tryLockRun is atomic and respects lease expiry', async () => {
    await store.createRun(run({ id: 'r1' }));
    expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
    expect(await store.tryLockRun('r1', 'B', 3_000, 1_500)).toBe(false);
    expect(await store.tryLockRun('r1', 'B', 4_000, 2_500)).toBe(true);
    await store.releaseRunLock('r1');
    expect(await store.tryLockRun('r1', 'C', 9_000, 2_600)).toBe(true);
  });

  it('stores and atomically takes a signal waiter', async () => {
    await store.putSignalWaiter({ token: 'approve-1', runId: 'r1', seq: 3 });
    expect((await store.takeSignalWaiter('approve-1'))?.seq).toBe(3);
    expect(await store.takeSignalWaiter('approve-1')).toBeNull();
  });

  it('round-trips searchAttributes and answers equality + range queries (pushdown)', async () => {
    await store.createRun(run({ id: 'a', searchAttributes: { amount: 30, tier: 'free' } }));
    await store.createRun(run({ id: 'b', searchAttributes: { amount: 200, tier: 'pro' } }));
    await store.createRun(run({ id: 'c', searchAttributes: { amount: 500, tier: 'pro' } }));

    expect((await store.getRun('b'))?.searchAttributes).toEqual({ amount: 200, tier: 'pro' });
    const big = await store.listRuns({ attributes: [{ key: 'amount', op: 'gte', value: 200 }] });
    expect(big.map((r) => r.id).sort()).toEqual(['b', 'c']);
    const proSmall = await store.listRuns({
      attributes: [
        { key: 'tier', op: 'eq', value: 'pro' },
        { key: 'amount', op: 'lt', value: 300 },
      ],
    });
    expect(proSmall.map((r) => r.id)).toEqual(['b']);
    const notFree = await store.listRuns({
      attributes: [{ key: 'tier', op: 'ne', value: 'free' }],
    });
    expect(notFree.map((r) => r.id).sort()).toEqual(['b', 'c']);
  });

  it('maintains the side-table on create and re-indexes on update', async () => {
    await store.createRun(run({ id: 'a', searchAttributes: { tier: 'free', amount: 10 } }));
    const created = await sharedPrisma.durableRunAttribute.findMany({
      where: { runId: 'a' },
      orderBy: { key: 'asc' },
      select: { key: true, strValue: true, numValue: true },
    });
    expect(created).toEqual([
      { key: 'amount', strValue: null, numValue: 10 },
      { key: 'tier', strValue: 'free', numValue: null },
    ]);

    await store.updateRun('a', { searchAttributes: { tier: 'pro' } });
    expect(
      (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] })).map(
        (r) => r.id,
      ),
    ).toEqual(['a']);
    expect(
      await store.listRuns({ attributes: [{ key: 'amount', op: 'eq', value: 10 }] }),
    ).toHaveLength(0);
    expect(
      await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'free' }] }),
    ).toHaveLength(0);
  });

  it('filters runs by tag via array_contains (Postgres-only)', async () => {
    await store.createRun(run({ id: 'a', tags: ['urgent', 'eu'] }));
    await store.createRun(run({ id: 'b', tags: ['eu'] }));
    await store.createRun(run({ id: 'c', tags: ['us'] }));
    expect((await store.listRuns({ tag: 'eu' })).map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect((await store.listRuns({ tag: 'urgent' })).map((r) => r.id)).toEqual(['a']);
  });

  it('runs the engine end-to-end durably, resuming without re-running steps', async () => {
    const engine = new WorkflowEngine({ store });
    let aRuns = 0;
    let failOnce = true;
    engine.register('wf', '1', async (c) => {
      const a = await c.step('a', async () => {
        aRuns += 1;
        return 10;
      });
      return c.step('b', async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('boom');
        }
        return a + 5;
      });
    });
    await engine.start('wf', { x: 1 }, 'run1');
    expect((await engine.waitForRun('run1')).status).toBe('failed');
    const resumed = await engine.resume('run1');
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe(15);
    expect(aRuns).toBe(1);
  });
});
