import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { PrismaStateStore } from './prisma-state-store';

// Integration test against real Prisma + SQLite. Skips cleanly if the client hasn't been
// generated (run `pnpm --filter @dudousxd/nestjs-durable-store-prisma prisma:generate`).
const pkgDir = resolve(__dirname, '..');
// The client is generated at test time, so it's untyped here.
let prisma: any;
let store: PrismaStateStore;
let available = false;

beforeAll(async () => {
  try {
    // Idempotent: creates the tables if missing. beforeEach clears rows between tests.
    execSync('npx prisma db push --schema prisma/test.prisma --skip-generate', {
      cwd: pkgDir,
      stdio: 'ignore',
    });
    const { PrismaClient } = await import('../generated/client/index.js');
    prisma = new PrismaClient();
    await prisma.$connect();
    store = new PrismaStateStore(prisma);
    available = true;
  } catch {
    available = false;
  }
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect?.();
});

beforeEach(async () => {
  if (!available) return;
  await prisma.durableStepCheckpoint.deleteMany();
  await prisma.durableSignalWaiter.deleteMany();
  await prisma.durableWorkflowRun.deleteMany();
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
