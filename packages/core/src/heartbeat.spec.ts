import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, RemoteTask, StepResult, Transport } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// NOTE (single ctx.step surface sweep, see docs/superpowers/plans/2026-07-02-durable-single-step.md):
// per-call `timeoutMs`/`retries` had NO home to migrate to. The old `RemoteStepDef({ timeoutMs,
// retries })` + `ctx.remote(def, input)` let a call site opt a step into the in-memory
// liveness-heartbeat path (`engine.ts` callRemoteInMemory/awaitWithHeartbeat). The new
// `ctx.step(handlerOrName, input, opts?)` only threads `StepDispatchOpts = { queue, priority,
// fairnessKey, transport }` into the `StepDef` it builds (`{ name }` — see `workflow-ctx.ts`), and
// the cross-runtime `kind:'call'` wire command never carried these fields either (checked
// `engine.ts` applyCommands — only `name`/`group`/`input`). So this capability is presently
// UNREACHABLE from any authoring surface, though the engine-side machinery it drove
// (`callRemoteInMemory`, `awaitWithHeartbeat`, `RemoteStepTimeout`) is still live code. Flagging
// for the plan owner rather than silently deleting: either reinstate a way to opt a dispatched step
// into this path (e.g. via `@Step({ timeoutMs, retries })` read at the dispatch boundary), or this
// engine code is now dead and worth removing in a follow-up.
describe.skip('remote-step liveness (heartbeats) — orphaned: no authoring surface sets timeoutMs/retries anymore', () => {
  it('times out and re-dispatches a presumed-dead worker, then fails', async () => {
    const transport = new ControlTransport();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('wf', '1', async (ctx) => ctx.step(JOB_STEP_NAME, {}));

    const res = await startRun(engine, 'wf', {}, 'r1'); // never delivered → timeout × 2 → fail
    expect(res.status).toBe('failed');
    expect(res.error?.message).toMatch(/no result\/heartbeat/);
    expect(transport.dispatched.length).toBe(2); // initial + 1 retry
  });

  it('a heartbeat rearms the window so a beating worker survives past timeoutMs', async () => {
    const transport = new ControlTransport();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('wf2', '1', async (ctx) => ctx.step(JOB_STEP_NAME, {}));

    await engine.start('wf2', {}, 'r2');
    const runPromise = engine.waitForRun('r2');
    await sleep(0); // let the dispatch happen
    const id = transport.dispatched[0]?.stepId as string;

    await sleep(40);
    await transport.heartbeatHandler?.({ runId: 'r2', seq: 0, stepId: id, group: 'g' }); // rearm
    await sleep(30); // 70ms total — past 60ms, but only 30ms since the last beat
    await transport.resultHandler?.({
      runId: 'r2',
      seq: 0,
      stepId: id,
      status: 'completed',
      output: 'ok',
    });

    const res = await runPromise;
    expect(res.status).toBe('completed');
    expect(res.output).toBe('ok');
  });
});
