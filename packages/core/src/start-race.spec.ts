import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkflowRun } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * REGRESSION: two starts of the same run id that race between `start`'s existence check and its
 * insert must converge on one run, not fail the loser.
 *
 * Under a 40k-child `ctx.all`, two turns of the parent started the same children. The loser's
 * insert hit the primary key, `start` threw, and the parent recorded 3,329 children as "failed to
 * start" — children that ran and completed — so the whole fan failed.
 */

/**
 * Rejects a duplicate id like the SQL stores' primary key, and hides a run from the first `getRun`
 * after a racing starter inserted it.
 */
class RacingStartStore extends InMemoryStateStore {
  hideOnce = new Set<string>();

  async getRun(runId: string): Promise<WorkflowRun | null> {
    if (this.hideOnce.delete(runId)) return null;
    return super.getRun(runId);
  }

  async createRun(run: WorkflowRun): Promise<void> {
    if (await super.getRun(run.id)) throw new Error(`Duplicate entry '${run.id}' for key PRIMARY`);
    return super.createRun(run);
  }
}

describe('REGRESSION: racing starts of the same run id', () => {
  it('the loser returns the winner run instead of throwing', async () => {
    const store = new RacingStartStore();
    const dispatched: string[] = [];
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: (runId) => void dispatched.push(runId) },
    });
    engine.register('line', '1', async () => 'done');

    await engine.start('line', { i: 1 }, 'child-1');
    store.hideOnce.add('child-1');

    await expect(engine.start('line', { i: 1 }, 'child-1')).resolves.toMatchObject({
      runId: 'child-1',
      status: 'pending',
    });
    expect(dispatched).toEqual(['child-1']);
  });

  it('still throws when the insert fails for a run that does not exist', async () => {
    const store = new InMemoryStateStore();
    store.createRun = async () => {
      throw new Error('connection lost');
    };
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => undefined } });
    engine.register('line', '1', async () => 'done');

    await expect(engine.start('line', {}, 'r1')).rejects.toThrow('connection lost');
  });
});
