import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

// NOTE (single ctx.step surface sweep, see docs/superpowers/plans/2026-07-02-durable-single-step.md):
// this whole file exercised the DURABLE retry/backoff branch of `callRemote`
// (`step.retries`/`backoffDelay(existing.attempts, step)` in `engine.ts`), driven by
// `RemoteStepDef({ retries, backoffMs })` + `ctx.remote(def, input)`. The new
// `ctx.step(handlerOrName, input, opts?)` only threads `StepDispatchOpts = { queue, priority,
// fairnessKey, transport }` into the `StepDef` it builds (`{ name }` only — see `workflow-ctx.ts`
// `step()`), and the cross-runtime `kind:'call'` wire command never carried `retries`/`backoffMs`
// either (checked `engine.ts` `applyCommands` — only `name`/`group`/`input`/`parallelGroup`). So
// per-call retry/backoff configuration is UNREACHABLE from any current authoring surface, though the
// engine-side retry machinery (`callRemote`'s `existing.status === 'failed'` branch, `backoffDelay`)
// is still live code. Skipped rather than deleted — flagging for the plan owner: either give a
// dispatched step a way to opt into durable retry/backoff again (e.g. `@Step({ retries, backoffMs })`
// read at the dispatch boundary, mirroring how `input`/`output` zod schemas attach), or this is now
// dead code worth removing.
describe.skip('durable remote step — retry with backoff — orphaned: no authoring surface sets retries/backoffMs anymore', () => {
  it('re-dispatches a failed durable step up to `retries`, spacing attempts by the backoff', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let attempts = 0;
    transport.handle('ext.flaky', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return { ok: true };
    });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.register(
      'wf',
      '1',
      async (ctx) => (await ctx.step<{ ok: boolean }>('ext.flaky', {})).ok,
    );

    await engine.start('wf', {}, 'r1');
    await flush(); // attempt 1 fails → checkpoint failed, run suspended awaiting the backoff
    expect(attempts).toBe(1);
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    nowMs = 1100;
    await engine.resumeDueTimers(nowMs);
    await flush(); // attempt 2 fails → suspended again
    expect(attempts).toBe(2);
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    nowMs = 1200;
    await engine.resumeDueTimers(nowMs);
    await flush(); // attempt 3 succeeds
    expect(attempts).toBe(3);
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe(true);
  });

  it('does not retry when the worker marks the error non-retryable', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let attempts = 0;
    transport.handle('ext.declined', async () => {
      attempts += 1;
      const err = Object.assign(new Error('declined'), { retryable: false });
      throw err;
    });
    const engine = new WorkflowEngine({ store, transport });
    engine.register('wf', '1', async (ctx) => ctx.step('ext.declined', {}));

    await engine.start('wf', {}, 'r1');
    await flush();
    expect(attempts).toBe(1); // no retry despite retries: 5
    expect((await store.getRun('r1'))?.status).toBe('failed');
  });
});
