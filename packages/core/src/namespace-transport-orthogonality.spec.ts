import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, RemoteTask, StepResult, Transport, WorkflowTask } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function poll(fn: () => Promise<boolean> | boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

/** Records workflow-turn dispatches and reports canned live groups — a bare-prefix broker stand-in. */
class RecordingTransport implements Transport {
  readonly workflowTasks: WorkflowTask[] = [];
  constructor(private readonly liveGroups: string[] = []) {}
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (b: Heartbeat) => Promise<void>): void {}
  async listWorkerGroups(): Promise<string[]> {
    return this.liveGroups;
  }
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.workflowTasks.push(task);
  }
}

describe('engine namespace vs transport keyspace — orthogonal axes', () => {
  it("a scoped engine's namespace NEVER re-scopes its transport (tenant rides group suffixes instead)", async () => {
    // The canonical cross-SDK convention: tenant workers (the Python SDK, the TS tenant role) live
    // on the transport's own prefix with `@<tenant>`-suffixed groups. A scoped engine therefore
    // routes its runs' work as `<name>@<tenant>` ON THAT SAME KEYSPACE — an earlier design instead
    // folded the namespace into the transport prefix, producing a keyspace no tenant worker could
    // see (the tenant encoded twice: prefix AND group suffix) and silently failing discovery.
    const transport = new RecordingTransport(['processing@dev-alice']);
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport,
      namespace: 'dev-alice',
    });

    await engine.start('processing', {}, 'r1');

    await poll(() => transport.workflowTasks.length === 1);
    // Same transport, same (bare) keyspace — tenant expressed ONLY in the group token.
    expect(transport.workflowTasks[0]?.group).toBe('processing@dev-alice');
  });

  it('an operator (no namespace) dispatches bare groups for default-namespace runs — names unchanged', async () => {
    const transport = new RecordingTransport(['processing']);
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });

    await engine.start('processing', {}, 'r2');

    await poll(() => transport.workflowTasks.length === 1);
    expect(transport.workflowTasks[0]?.group).toBe('processing');
  });
});
