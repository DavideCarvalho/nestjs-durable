import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Transport, WorkflowTask } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function poll(fn: () => Promise<boolean> | boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

/** A transport whose keyspace reports a canned set of live groups and records workflow-turn
 *  dispatches — a stand-in for one member of a mixed (scoped + bare prefix) pool. */
class RecordingTransport implements Transport {
  constructor(
    private readonly liveGroups: string[],
    private readonly workflowTasks: WorkflowTask[],
  ) {}
  async dispatch(): Promise<void> {}
  onResult(): void {}
  onHeartbeat(): void {}
  async listWorkerGroups(): Promise<string[]> {
    return this.liveGroups;
  }
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.workflowTasks.push(task);
  }
}

describe('convention routing resolves the transport whose keyspace reports the live group', () => {
  it('dispatches on the transport that sees the tenant worker — not blindly on primary', async () => {
    const store = new InMemoryStateStore();
    const scopedTasks: WorkflowTask[] = [];
    const bareTasks: WorkflowTask[] = [];
    // Primary: a namespaced-transport stand-in — its (scoped) keyspace has no live worker for the
    // group. Secondary: a bare-prefix stand-in where an operator-convention tenant worker (e.g. the
    // Python SDK with DURABLE_TENANT=acme) heartbeats `processing@acme`. Before the fix the
    // convention resolver checked the MERGED group list but always dispatched on `pool.primary`,
    // parking the turn on a queue nobody consumes.
    const scoped = new RecordingTransport([], scopedTasks);
    const bare = new RecordingTransport(['processing@acme'], bareTasks);
    const engine = new WorkflowEngine({
      store,
      namespace: 'acme',
      transports: [
        { id: 'scoped', transport: scoped },
        { id: 'bare', transport: bare },
      ],
    });

    await engine.start('processing', {}, 'r1');

    await poll(() => bareTasks.length === 1);
    expect(bareTasks[0]?.group).toBe('processing@acme');
    expect(scopedTasks).toHaveLength(0);
  });

  it('single-transport pools keep today’s behavior (resolve + dispatch on it)', async () => {
    const store = new InMemoryStateStore();
    const tasks: WorkflowTask[] = [];
    const only = new RecordingTransport(['processing'], tasks);
    const engine = new WorkflowEngine({ store, transport: only });

    await engine.start('processing', {}, 'r2');

    await poll(() => tasks.length === 1);
    expect(tasks[0]?.group).toBe('processing');
  });

  it('no transport reporting the group still means "not registered"', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transports: [
        { id: 'a', transport: new RecordingTransport([], []) },
        { id: 'b', transport: new RecordingTransport(['other-group'], []) },
      ],
    });

    await expect(engine.start('processing', {}, 'r3')).rejects.toThrow(/not registered/);
  });
});
