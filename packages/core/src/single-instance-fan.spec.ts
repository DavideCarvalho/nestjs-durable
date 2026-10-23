import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, RemoteTask, StepResult, Transport } from './interfaces';
import { runStepHandler } from './protocol';
import { InMemoryRunQueue } from './testing/in-memory-run-queue';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * One instance consuming its own run queue, running the shape of a per-base ingestion: a singleton
 * parent that upserts search attributes and dispatches steps around a `ctx.all` of children, each
 * of which upserts its own search attributes and dispatches one step. Steps come back from an
 * in-process worker with random latency, so children routinely finish while the parent's turn that
 * started them is still running. Every parent completes on wakes alone: the clock never reaches
 * `reconcileMs`, and nothing polls.
 */

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = () => pause(Math.random() * 8);

/** Remote steps answered by an in-process worker, plus a run queue: one instance's transport. */
function stepsAndRuns(queue: InMemoryRunQueue): Transport {
  const runs = queue.transport();
  let onResult: ((result: StepResult) => Promise<void>) | undefined;
  return {
    ...runs,
    async dispatch(task: RemoteTask) {
      void (async () => {
        await jitter();
        const result = await runStepHandler(task, async (input: unknown) => {
          await jitter();
          return task.name === 'checkFile' ? { slices: [1, 2, 3] } : input;
        });
        await jitter();
        await onResult?.(result);
      })();
    },
    onResult(handler) {
      onResult = handler;
    },
    onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>) {},
  };
}

describe.each([
  { name: 'ctx.all', settle: false },
  { name: 'ctx.allSettled', settle: true },
])('a single instance running singleton ingestions with a $name of children', ({ settle }) => {
  it.each([
    { bases: 1, runs: 40 },
    { bases: 10, runs: 120 },
  ])(
    'completes $runs runs over $bases singleton key(s) without reconcileMs',
    async ({ bases, runs }) => {
      const store = new InMemoryStateStore();
      const now = Date.now();
      const engine = new WorkflowEngine({
        store,
        transport: stepsAndRuns(new InMemoryRunQueue()),
        clock: () => now,
        remoteRedispatchMs: 3_600_000,
      });
      engine.register('line', '1', async (ctx, input) => {
        await ctx.upsertSearchAttributes({ fileKey: 'f' });
        return ctx.step('ingestLines', input);
      });
      engine.register(
        'ingestion',
        '2',
        async (ctx, input) => {
          await ctx.upsertSearchAttributes({ baseId: (input as { base: string }).base });
          await ctx.step('claimNextFile', {});
          await ctx.upsertSearchAttributes({ fileKey: 'k' });
          const plan = (await ctx.step('checkFile', {})) as { slices: number[] };
          const inputs = plan.slices.map((slice) => ({ slice }));
          const out = settle ? await ctx.allSettled('line', inputs) : await ctx.all('line', inputs);
          await ctx.step('finishFile', {});
          await ctx.upsertSearchAttributes({ savedLines: out.length });
          return out.length;
        },
        { singleton: { key: (input) => (input as { base: string }).base } },
      );
      engine.consumeRuns();
      for (let i = 0; i < runs; i += 1) {
        await engine.start('ingestion', { base: `base-${i % bases}` }, `run-${i}`);
      }
      const deadline = Date.now() + 60_000;
      let completed = 0;
      while (Date.now() < deadline) {
        completed = (await store.listRuns({ workflow: 'ingestion', status: 'completed' })).length;
        if (completed === runs) break;
        await pause(25);
      }
      expect(completed).toBe(runs);
      for (const run of await store.listRuns({ workflow: 'ingestion' })) {
        expect(run.searchAttributes).toMatchObject({ fileKey: 'k', savedLines: 3 });
      }
      await engine.drain(1_000);
    },
    90_000,
  );
});
