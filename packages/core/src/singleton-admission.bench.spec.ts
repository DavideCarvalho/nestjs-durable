import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { RunQuery, WorkflowRun } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

class CountingStore extends InMemoryStateStore {
  listRunsCalls = 0;
  admissionCalls = 0;
  override async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    this.listRunsCalls++;
    return super.listRuns(query);
  }
  override async tryAdmitSingleton(
    runId: string,
    tag: string,
    workflow: string,
    limit: number,
    retryWakeAt?: number,
  ): Promise<boolean> {
    this.admissionCalls++;
    return super.tryAdmitSingleton(runId, tag, workflow, limit, retryWakeAt);
  }
}

describe('singleton admission operations', () => {
  it('uses one atomic claim and one release notification scan per uncontended run', async () => {
    const store = new CountingStore();
    const engine = new WorkflowEngine({ store });
    engine.register('job', '1', async () => 'done', { singleton: { key: () => 'k' } });
    expect((await startRun(engine, 'job', {}, 'solo')).status).toBe('completed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.admissionCalls).toBe(1);
    expect(store.listRunsCalls).toBe(1);
    await engine.drain();
  });
});
