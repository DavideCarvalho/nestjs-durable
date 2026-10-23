import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, RemoteTask, StepResult, Transport } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/** A transport whose result/heartbeat delivery the test drives by hand. */
class ControlTransport implements Transport {
  resultHandler?: (r: StepResult) => Promise<void>;
  heartbeatHandler?: (b: Heartbeat) => Promise<void>;
  readonly dispatched: RemoteTask[] = [];
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(h: (r: StepResult) => Promise<void>): void {
    this.resultHandler = h;
  }
  onHeartbeat(h: (b: Heartbeat) => Promise<void>): void {
    this.heartbeatHandler = h;
  }
}

const JOB_STEP_NAME = 'job';

// Per-call `timeoutMs`/`retries` opt a dispatched step into the in-memory liveness-heartbeat path
// (`engine.ts` callRemoteInMemory/awaitWithHeartbeat) via the 3rd `ctx.step(name, input, opts)`
// argument — restored on `StepDispatchOpts` (see `interfaces.ts`) and threaded into the `StepDef`
// `ctx.step` builds (`workflow-ctx.ts`), re-enabling this engine-side machinery.
describe('remote-step liveness (heartbeats)', () => {
  it('times out and re-dispatches a presumed-dead worker, then fails', async () => {
    const transport = new ControlTransport();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('wf', '1', async (ctx) =>
      ctx.step(JOB_STEP_NAME, {}, { timeoutMs: 30, retries: 2 }),
    );

    const res = await startRun(engine, 'wf', {}, 'r1'); // never delivered → timeout × 2 → fail
    expect(res.status).toBe('failed');
    expect(res.error?.message).toMatch(/no result\/heartbeat/);
    expect(transport.dispatched.length).toBe(2); // initial + 1 retry
  });

  it('a heartbeat rearms the window so a beating worker survives past timeoutMs', async () => {
    // Fake timers: the 60ms liveness window only moves when the test advances the clock, so a stall
    // in the test process (GC, a busy CI runner) can't let the window lapse before the beat lands.
    vi.useFakeTimers();
    try {
      const transport = new ControlTransport();
      const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
      engine.register('wf2', '1', async (ctx) => ctx.step(JOB_STEP_NAME, {}, { timeoutMs: 60 }));

      await engine.start('wf2', {}, 'r2');
      const runPromise = engine.waitForRun('r2');
      // Flush without moving the clock until the step is dispatched (its window is then armed).
      for (let i = 0; i < 100 && transport.dispatched.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      const id = transport.dispatched[0]?.stepId as string;
      expect(id).toBeDefined();

      await vi.advanceTimersByTimeAsync(40);
      await transport.heartbeatHandler?.({ runId: 'r2', seq: 0, stepId: id, group: 'g' }); // rearm
      await vi.advanceTimersByTimeAsync(50); // 90ms total — past 60ms, but only 50ms since the beat
      await transport.resultHandler?.({
        runId: 'r2',
        seq: 0,
        stepId: id,
        status: 'completed',
        output: 'ok',
      });
      await vi.advanceTimersByTimeAsync(0);

      const res = await runPromise;
      expect(res.status).toBe('completed');
      expect(res.output).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});
