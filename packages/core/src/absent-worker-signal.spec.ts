import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, RemoteTask, StepResult, Transport } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/** A transport whose live worker groups are mutable, so a test can bring a pool up/down. */
class Broker implements Transport {
  liveGroups: string[] = [];
  autoComplete = false;
  readonly stepGroups: string[] = [];
  private result?: (r: StepResult) => Promise<void>;

  async dispatch(task: RemoteTask): Promise<void> {
    this.stepGroups.push(task.group);
    if (!this.autoComplete) return;
    setImmediate(() => {
      void this.result?.({
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
    this.result = h;
  }
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}
  async listWorkerGroups(): Promise<string[]> {
    return this.liveGroups;
  }
}

async function poll(fn: () => Promise<boolean>, ms = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

describe('blockOnAbsentWorker: a step to a group with no live worker parks the run (LOUD), self-heals', () => {
  it('parks `blocked` with a clear reason instead of dispatching into an empty queue', async () => {
    const store = new InMemoryStateStore();
    const transport = new Broker(); // no live groups
    const engine = new WorkflowEngine({
      store,
      transport,
      blockOnAbsentWorker: true,
      blockedPollMs: 10,
    });
    engine.register('w', '1', async (ctx) => {
      await ctx.step('ingest', {});
      return 'ok';
    });

    await engine.start('w', {}, 'r1');
    await poll(async () => (await store.getRun('r1'))?.status === 'blocked');

    expect(transport.stepGroups).toEqual([]); // nothing dispatched into the void
    expect((await store.getRun('r1'))?.error?.code).toBe('worker.absent');

    // the pool appears → the blocked-recovery poll re-drives → dispatches + completes
    transport.liveGroups = ['ingest'];
    transport.autoComplete = true;
    await engine.resumeDueTimers(Date.now() + 1000);
    await poll(async () => (await store.getRun('r1'))?.status === 'completed');

    expect(transport.stepGroups).toEqual(['ingest']);
  });

  it('OFF by default: the step is dispatched into the queue and the run suspends (unchanged)', async () => {
    const store = new InMemoryStateStore();
    const transport = new Broker(); // no live groups
    const engine = new WorkflowEngine({ store, transport });
    engine.register('w', '1', async (ctx) => {
      await ctx.step('ingest', {});
      return 'ok';
    });

    await engine.start('w', {}, 'r2');
    await poll(async () => (await store.getRun('r2'))?.status === 'suspended');

    expect(transport.stepGroups).toEqual(['ingest']); // dispatched as before, sits in the queue
  });

  it('with the flag on but a worker LIVE, dispatch proceeds normally', async () => {
    const store = new InMemoryStateStore();
    const transport = new Broker();
    transport.liveGroups = ['ingest'];
    transport.autoComplete = true;
    const engine = new WorkflowEngine({ store, transport, blockOnAbsentWorker: true });
    engine.register('w', '1', async (ctx) => {
      await ctx.step('ingest', {});
      return 'ok';
    });

    await engine.start('w', {}, 'r3');
    await poll(async () => (await store.getRun('r3'))?.status === 'completed');

    expect(transport.stepGroups).toEqual(['ingest']);
  });
});
