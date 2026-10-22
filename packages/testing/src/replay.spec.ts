import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import {
  RUN_HISTORY_FIXTURE_VERSION,
  type RunHistory,
  assertReplayable,
  captureHistory,
  parseRunHistory,
  serializeRunHistory,
} from './replay';

// Capture a real run's history the way a CI fixture would.
async function recordHistory(register: (e: WorkflowEngine) => void): Promise<RunHistory> {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  register(engine);
  await engine.start('wf', {}, 'run1');
  await engine.waitForRun('run1'); // execute (dispatch model) until it suspends mid-way
  const run = await store.getRun('run1');
  if (!run) throw new Error('no run');
  return { run, checkpoints: await store.listCheckpoints('run1') };
}

const v1 = (e: WorkflowEngine) =>
  e.register('wf', '1', async (ctx) => {
    await ctx.localStep('a', async () => 1);
    await ctx.waitForSignal('go');
    await ctx.localStep('b', async () => 2);
  });

describe('assertReplayable', () => {
  it('passes when the workflow code is unchanged', async () => {
    const history = await recordHistory(v1);
    await expect(assertReplayable(v1, history)).resolves.toBeUndefined();
  });

  it('throws when a step was renamed/reordered under the recorded history', async () => {
    const history = await recordHistory(v1);
    const changed = (e: WorkflowEngine) =>
      e.register('wf', '1', async (ctx) => {
        await ctx.localStep('renamed', async () => 1); // seq 0 was "a" in the history
        await ctx.waitForSignal('go');
        await ctx.localStep('b', async () => 2);
      });
    await expect(assertReplayable(changed, history)).rejects.toThrow(/non-determinism/);
  });
});

describe('replay fixtures (captureHistory / serializeRunHistory / parseRunHistory)', () => {
  async function runV1(): Promise<{ engine: WorkflowEngine; store: InMemoryStateStore }> {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    v1(engine);
    await engine.start('wf', {}, 'run1');
    await engine.waitForRun('run1');
    return { engine, store };
  }

  it('round-trips a captured run through JSON and replays it', async () => {
    const { engine } = await runV1();
    const history = await captureHistory(engine, 'run1');
    if (!history) throw new Error('no history');
    expect(history.checkpoints.length).toBeGreaterThan(0);
    const json = serializeRunHistory(history);
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json).version).toBe(RUN_HISTORY_FIXTURE_VERSION);
    const parsed = parseRunHistory(json);
    expect(parsed.run.createdAt).toBeInstanceOf(Date);
    expect(parsed.run.createdAt.getTime()).toBe(history.run.createdAt.getTime());
    expect(parsed.checkpoints[0]?.finishedAt).toBeInstanceOf(Date);
    await expect(assertReplayable(v1, parsed)).resolves.toBeUndefined();
    const renamed = (e: WorkflowEngine) =>
      e.register('wf', '1', async (ctx) => {
        await ctx.localStep('renamed', async () => 1);
        await ctx.waitForSignal('go');
      });
    await expect(assertReplayable(renamed, parsed)).rejects.toThrow(/non-determinism/);
  });

  it('captures from a bare store too, and returns null for an unknown run', async () => {
    const { store } = await runV1();
    expect((await captureHistory(store, 'run1'))?.run.id).toBe('run1');
    expect(await captureHistory(store, 'nope')).toBeNull();
  });

  it('rejects JSON that is not a fixture', () => {
    expect(() => parseRunHistory('{"hello":1}')).toThrow(/not a run history fixture/);
  });
});
