import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { runStateStoreContract } from '@dudousxd/nestjs-durable-testing';
import { PrismaStateStore } from './prisma-state-store';

// The SHARED cross-store behavioral contract, run here against real Prisma + SQLite. Reuses one
// generated client + pushed DB (slow to spin up) and truncates between cases. NOTE on the DB matrix:
// the Prisma client is generated for ONE provider at a time (the committed client targets sqlite), so
// there is no `prisma-state-store.db.spec.ts` — running against a Postgres/MySQL container would need
// a `prisma generate` with a different provider + a fresh `db push` at test time. See the
// `// PRISMA DB MATRIX` note below for why that's flagged rather than wired in.
// ONE shared client + pushed DB for the whole file. SQLite tolerates a single writer connection; a
// second PrismaClient against the same file would lock (P1008), so the contract and the per-store
// tests below both use this one.
let sharedPrisma: any;
let prismaReady: Promise<boolean> | undefined;

async function prismaContractSetup(): Promise<boolean> {
  if (!prismaReady) {
    prismaReady = (async () => {
      try {
        execSync('npx prisma db push --schema prisma/test.prisma --skip-generate', {
          cwd: resolve(__dirname, '..'),
          stdio: 'ignore',
        });
        const { PrismaClient } = await import('../generated/client/index.js');
        // Query logging lets the per-store pushdown test below capture the executed SQL.
        sharedPrisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        await sharedPrisma.$connect();
        return true;
      } catch {
        return false;
      }
    })();
  }
  return prismaReady;
}

async function truncatePrisma(): Promise<void> {
  await sharedPrisma.durableStepCheckpoint.deleteMany();
  await sharedPrisma.durableSignalWaiter.deleteMany();
  await sharedPrisma.durableBufferedSignal.deleteMany();
  await sharedPrisma.durableRunAttribute.deleteMany(); // before runs (FK)
  await sharedPrisma.durableWorkflowRun.deleteMany();
}

runStateStoreContract('Prisma (SQLite)', async () => {
  const ok = await prismaContractSetup();
  if (!ok) throw new Error('Prisma client/DB not available (run prisma:generate)');
  await truncatePrisma();
  return {
    store: new PrismaStateStore(sharedPrisma),
    // `listRuns({ tag })` uses Prisma's `array_contains`, which Prisma supports on its real targets
    // (Postgres/MySQL) but NOT on SQLite, the adapter's test DB only. Skipped here; asserted elsewhere.
    supportsTagFilter: false,
    cleanup: async () => undefined,
  };
});

// Integration test against real Prisma + SQLite. Skips cleanly if the client hasn't been
// generated (run `pnpm --filter @dudousxd/nestjs-durable-store-prisma prisma:generate`).
// The client is generated at test time, so it's untyped here.
let prisma: any;
let store: PrismaStateStore;
let available = false;

beforeAll(async () => {
  available = await prismaContractSetup(); // reuse the single shared client (avoids SQLite P1008 locks)
  if (available) {
    prisma = sharedPrisma;
    store = new PrismaStateStore(prisma);
  }
}, 60_000);

afterAll(async () => {
  await sharedPrisma?.$disconnect?.();
});

beforeEach(async () => {
  if (!available) return;
  await truncatePrisma();
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

describe('PrismaStateStore', () => {
  it('persists a run with JSON input and reads it back', async (ctx) => {
    if (!available) ctx.skip();
    await store.createRun(run());
    const loaded = await store.getRun('r1');
    expect(loaded?.workflow).toBe('checkout');
    expect(loaded?.input).toEqual({ orderId: 'o1' });
  });

  it('upserts checkpoints and reads them by (runId, seq)', async (ctx) => {
    if (!available) ctx.skip();
    await store.createRun(run());
    await store.saveCheckpoint(checkpoint());
    await store.saveCheckpoint(
      checkpoint({ seq: 1, name: 'charge', output: { chargeId: 'ch_1' } }),
    );
    expect((await store.getCheckpoint('r1', 0))?.output).toEqual({ ok: true });
    expect((await store.getCheckpoint('r1', 1))?.name).toBe('charge');
    expect(await store.listCheckpoints('r1')).toHaveLength(2);
  });

  it('lists incomplete runs and due timers', async (ctx) => {
    if (!available) ctx.skip();
    await store.createRun(run({ id: 'running1', status: 'running' }));
    await store.createRun(run({ id: 'suspended1', status: 'suspended', wakeAt: 5_000 }));
    await store.createRun(run({ id: 'done1', status: 'completed' }));
    expect((await store.listIncompleteRuns()).map((r) => r.id)).toEqual(['running1']);
    expect((await store.listDueTimers(10_000)).map((r) => r.id)).toEqual(['suspended1']);
    expect(await store.listDueTimers(1_000)).toHaveLength(0);
  });

  it('tryLockRun is atomic and respects lease expiry', async (ctx) => {
    if (!available) ctx.skip();
    await store.createRun(run({ id: 'r1' }));
    expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
    expect(await store.tryLockRun('r1', 'B', 3_000, 1_500)).toBe(false);
    expect(await store.tryLockRun('r1', 'B', 4_000, 2_500)).toBe(true);
    await store.releaseRunLock('r1');
    expect(await store.tryLockRun('r1', 'C', 9_000, 2_600)).toBe(true);
  });

  it('stores and atomically takes a signal waiter', async (ctx) => {
    if (!available) ctx.skip();
    await store.putSignalWaiter({ token: 'approve-1', runId: 'r1', seq: 3 });
    expect((await store.takeSignalWaiter('approve-1'))?.seq).toBe(3);
    expect(await store.takeSignalWaiter('approve-1')).toBeNull();
  });

  it('round-trips searchAttributes and answers equality + range queries (pushdown)', async (ctx) => {
    if (!available) ctx.skip();
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
    // `ne` excludes the matching value AND absent keys (missing-key-never-matches contract).
    const notFree = await store.listRuns({
      attributes: [{ key: 'tier', op: 'ne', value: 'free' }],
    });
    expect(notFree.map((r) => r.id).sort()).toEqual(['b', 'c']);
  });

  it('pushes attribute predicates DOWN into SQL via EXISTS on the side-table', async (ctx) => {
    if (!available) ctx.skip();
    const queries: string[] = [];
    const onQuery = (e: { query: string }) => queries.push(e.query);
    prisma.$on('query', onQuery);
    try {
      await store.createRun(run({ id: 'a', searchAttributes: { amount: 30 } }));
      await store.createRun(run({ id: 'b', searchAttributes: { amount: 200 } }));
      queries.length = 0;
      const res = await store.listRuns({
        attributes: [{ key: 'amount', op: 'gte', value: 100 }],
        limit: 10,
      });
      expect(res.map((r) => r.id)).toEqual(['b']);
      const select = queries.find((q) => /select/i.test(q) && /durable_workflow_runs/i.test(q));
      expect(select).toBeDefined();
      // Prisma compiles a relation `some` filter to a correlated EXISTS on the side-table.
      expect(select).toMatch(/exists/i);
      expect(select).toMatch(/durable_run_attributes/i);
      expect(select).toMatch(/limit/i); // pagination pushed to the DB
    } finally {
      prisma.$off?.('query', onQuery);
    }
  });

  it('maintains the side-table on create and re-indexes on update', async (ctx) => {
    if (!available) ctx.skip();
    await store.createRun(run({ id: 'a', searchAttributes: { tier: 'free', amount: 10 } }));
    const created = await prisma.durableRunAttribute.findMany({
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

  it('runs the engine end-to-end durably, resuming without re-running steps', async (ctx) => {
    if (!available) ctx.skip();
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
