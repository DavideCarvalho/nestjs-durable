import { WorkflowEngine } from './engine';
import type { WorkflowRun } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/**
 * REGRESSION: a `ctx.step` result that lands while the turn that dispatched it still holds the
 * run's lease must still resume the run.
 *
 * The result's resume reaches `execute`, finds the lease held, and returns without doing anything.
 * The turn then writes `suspended` and releases the lease — with the step already `completed` and
 * nothing left to wake the run. Under a wide `ctx.all` fan (40k children, six workers, event loops
 * lagging up to a second) this parked ~5k children until their redispatch deadline, an hour later.
 *
 * The store below holds the turn's `suspended` write until the result has landed and its resume
 * has been dropped, which is the state that race produces. `reconcileMs: 0` turns the orphan
 * sweep off, so the test asserts the wake itself rather than the safety net.
 */

const STEP = 'lines.process';

class SuspendAfterResultStore extends InMemoryStateStore {
  held = false;

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    if (patch.status === 'suspended' && !this.held) {
      this.held = true;
      for (let i = 0; i < 200; i += 1) {
        const cp = await this.getCheckpoint(runId, 0);
        if (cp?.status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      // Let the result's resume reach `execute` and be dropped on the held lease.
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    return super.updateRun(runId, patch);
  }
}

async function settle(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run ${runId} missing`);
  return run;
}

describe('REGRESSION: a step result that lands during the dispatching turn', () => {
  it('resumes the run once the turn releases its lease', async () => {
    const store = new SuspendAfterResultStore();
    const transport = new InMemoryTransport();
    transport.handle(STEP, async (input: { index: number }) => ({ index: input.index }));

    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    engine.register('line', '1', async (ctx) => ctx.step<{ index: number }>(STEP, { index: 7 }));

    await startRun(engine, 'line', {}, 'run1');
    const run = await settle(store, 'run1');

    expect(store.held).toBe(true);
    expect((await store.getCheckpoint('run1', 0))?.status).toBe('completed');
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ index: 7 });
  });
});
