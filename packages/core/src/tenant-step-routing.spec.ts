import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, RemoteTask, StepResult, Transport } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/** Records the routing token every dispatched step task carries. */
class RecordingTransport implements Transport {
  readonly groups: string[] = [];
  private resultHandler?: (r: StepResult) => Promise<void>;
  /** When true, every dispatched task immediately succeeds — so a run can proceed past its steps. */
  constructor(private readonly autoComplete = false) {}
  async dispatch(task: RemoteTask): Promise<void> {
    this.groups.push(task.group);
    if (!this.autoComplete) return;
    setImmediate(() => {
      void this.resultHandler?.({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        name: task.name,
        status: 'completed',
        output: { ok: true },
      } as StepResult);
    });
  }
  onResult(h: (r: StepResult) => Promise<void>): void {
    this.resultHandler = h;
  }
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}
  async listWorkerGroups(): Promise<string[]> {
    return [];
  }
}

async function poll(fn: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

describe('remote step routing follows the RUN tenant', () => {
  it('a tenant-stamped run dispatches its remote step to `<step>@<tenant>`', async () => {
    const store = new InMemoryStateStore();
    const transport = new RecordingTransport();
    // A global operator (namespace undefined) driving another tenant's run — the hybrid topology.
    const engine = new WorkflowEngine({ store, transport });
    engine.register('pipeline', '1', async (ctx) => {
      await ctx.step('IngestionRead.run', { file: 'x' });
      return 'ok';
    });

    await engine.start('pipeline', {}, 'r1', { namespace: 'jordi-local' });
    await poll(() => transport.groups.length > 0);

    expect(transport.groups).toEqual(['IngestionRead.run@jordi-local']);
  });

  it('the checkpoint records the same tenant-suffixed workerGroup it dispatched to', async () => {
    const store = new InMemoryStateStore();
    const transport = new RecordingTransport();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('pipeline', '1', async (ctx) => {
      await ctx.step('IngestionRead.run', { file: 'x' });
      return 'ok';
    });

    await engine.start('pipeline', {}, 'r2', { namespace: 'jordi-local' });
    await poll(() => transport.groups.length > 0);

    expect((await store.getCheckpoint('r2', 0))?.workerGroup).toBe('IngestionRead.run@jordi-local');
  });

  it('an un-namespaced run still dispatches BARE (single-tenant stays byte-identical)', async () => {
    const store = new InMemoryStateStore();
    const transport = new RecordingTransport();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('pipeline', '1', async (ctx) => {
      await ctx.step('IngestionRead.run', { file: 'x' });
      return 'ok';
    });

    await engine.start('pipeline', {}, 'r3');
    await poll(() => transport.groups.length > 0);

    expect(transport.groups).toEqual(['IngestionRead.run']);
  });

  it('the in-memory liveness path (`timeoutMs`) carries the tenant too', async () => {
    const store = new InMemoryStateStore();
    const transport = new RecordingTransport();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('pipeline', '1', async (ctx) => {
      await ctx.step('IngestionRead.run', { file: 'x' }, { timeoutMs: 60_000 });
      return 'ok';
    });

    await engine.start('pipeline', {}, 'r5', { namespace: 'jordi-local' });
    await poll(() => transport.groups.length > 0);

    expect(transport.groups).toEqual(['IngestionRead.run@jordi-local']);
  });

  it('a saga compensation dispatches to the tenant too', async () => {
    const store = new InMemoryStateStore();
    const transport = new RecordingTransport(true); // steps succeed so the undo can be reached
    const engine = new WorkflowEngine({ store, transport });
    engine.register('pipeline', '1', async (ctx) => {
      await ctx.step('Charge.card', { amount: 1 }, { compensate: 'Charge.refund' });
      throw new Error('boom'); // fail AFTER the step completed -> unwinds the compensation
    });

    await engine.start('pipeline', {}, 'r6', { namespace: 'jordi-local' });
    await poll(() => transport.groups.length > 1);

    expect(transport.groups).toEqual([
      'Charge.card@jordi-local',
      'Charge.refund@jordi-local', // the undo must land on the SAME tenant's pool
    ]);
  });

  it("the 'default' tenant also stays BARE", async () => {
    const store = new InMemoryStateStore();
    const transport = new RecordingTransport();
    const engine = new WorkflowEngine({ store, transport, namespace: 'default' });
    engine.register('pipeline', '1', async (ctx) => {
      await ctx.step('IngestionRead.run', { file: 'x' });
      return 'ok';
    });

    await engine.start('pipeline', {}, 'r4');
    await poll(() => transport.groups.length > 0);

    expect(transport.groups).toEqual(['IngestionRead.run']);
  });
});
