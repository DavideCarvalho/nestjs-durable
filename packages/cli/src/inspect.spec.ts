import {
  InMemoryStateStore,
  RUN_HISTORY_FIXTURE_VERSION,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { cancelRun, exportRun, inspect, parseDurationMs } from './inspect';

async function storeWithRuns() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('checkout', '1', async (ctx) => {
    await ctx.localStep('reserveStock', async () => 1);
    await ctx.localStep('ship', async () => 2);
    return 'ok';
  });
  await engine.start('checkout', {}, 'run1');
  await engine.waitForRun('run1');
  return store;
}

describe('inspect', () => {
  it('lists runs as a table', async () => {
    const out = await inspect(await storeWithRuns(), {});
    expect(out).toContain('WORKFLOW');
    expect(out).toContain('checkout');
    expect(out).toContain('run1');
    expect(out).toContain('completed');
  });

  it('shows a run timeline when given a runId', async () => {
    const out = await inspect(await storeWithRuns(), { runId: 'run1' });
    expect(out).toContain('checkout');
    expect(out).toContain('reserveStock');
    expect(out).toContain('ship');
    expect(out).toContain('local');
  });

  it('reports a missing run', async () => {
    const out = await inspect(new InMemoryStateStore(), { runId: 'nope' });
    expect(out).toMatch(/not found/i);
  });

  it('says when there are no runs', async () => {
    const out = await inspect(new InMemoryStateStore(), {});
    expect(out).toMatch(/no runs/i);
  });

  it('filters by status', async () => {
    const out = await inspect(await storeWithRuns(), { status: 'failed' });
    expect(out).not.toContain('run1');
  });
});

describe('cancelRun', () => {
  it('marks a live run cancelled', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wait', '1', async (ctx) => ctx.waitForSignal('go'));
    await engine.start('wait', {}, 'r1'); // suspends
    await engine.waitForRun('r1');
    expect(await cancelRun(store, 'r1')).toMatch(/cancelled/i);
    expect((await store.getRun('r1'))?.status).toBe('cancelled');
  });

  it('is a no-op on an already-completed run', async () => {
    const store = await storeWithRuns();
    expect(await cancelRun(store, 'run1')).toMatch(/already completed/i);
  });
});

describe('inspect --stale', () => {
  async function storeWithStranded() {
    const store = new InMemoryStateStore();
    const old = new Date(Date.now() - 30 * 60_000);
    const base = { workflowVersion: '1', input: {}, createdAt: old, updatedAt: old };
    // Suspended with no wake timer: nothing will re-drive it.
    await store.createRun({ ...base, id: 'stuck', workflow: 'pipeline', status: 'suspended' });
    // A long sleep: future wakeAt, not stranded.
    await store.createRun({
      ...base,
      id: 'napping',
      workflow: 'pipeline',
      status: 'suspended',
      wakeAt: Date.now() + 60 * 60_000,
    });
    await store.createRun({ ...base, id: 'finished', workflow: 'pipeline', status: 'completed' });
    return store;
  }

  it('lists only the stranded runs, with a recovery hint', async () => {
    const out = await inspect(await storeWithStranded(), { staleMs: 15 * 60_000 });
    expect(out).toContain('stuck');
    expect(out).toContain('no wake timer');
    expect(out).not.toContain('napping');
    expect(out).not.toContain('finished');
    expect(out).toContain('redispatchPending');
  });

  it('respects the threshold', async () => {
    const out = await inspect(await storeWithStranded(), { staleMs: 60 * 60_000 });
    expect(out).toBe('No stranded runs.');
  });

  it('parses compact durations', () => {
    expect(parseDurationMs('90s')).toBe(90_000);
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('4h')).toBe(4 * 3_600_000);
    expect(parseDurationMs('2d')).toBe(2 * 86_400_000);
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('15mins')).toBeUndefined();
  });
});

describe('export', () => {
  it('writes a replay fixture of the run and its checkpoints', async () => {
    const json = await exportRun(await storeWithRuns(), 'run1');
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json as string);
    expect(parsed.version).toBe(RUN_HISTORY_FIXTURE_VERSION);
    expect(parsed.run.id).toBe('run1');
    expect(parsed.checkpoints.map((c: { name: string }) => c.name)).toEqual([
      'reserveStock',
      'ship',
    ]);
  });

  it('returns null for an unknown run', async () => {
    expect(await exportRun(new InMemoryStateStore(), 'nope')).toBeNull();
  });
});
