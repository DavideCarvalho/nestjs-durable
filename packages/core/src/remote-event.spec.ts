import { WorkflowEngine } from './engine';
import { collectMetrics } from './metrics';
import { isRemoteEvent, markRemoteEvent } from './remote-event';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/** Two engines sharing a store and a broadcast transport: a pod that runs the work and one that only hears it. */
function twoInstances() {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const worker = new WorkflowEngine({
    store,
    transport,
    controlPlane: transport,
    instanceId: 'worker',
  });
  const other = new WorkflowEngine({
    store,
    transport,
    controlPlane: transport,
    instanceId: 'other',
  });
  worker.register('wf', '1', async (ctx) => {
    await ctx.localStep('a', async () => 1);
    return 'ok';
  });
  return { worker, other };
}

describe('events re-delivered from another instance', () => {
  it('are marked remote where they are heard, and not where they were produced', async () => {
    const { worker, other } = twoInstances();
    const local: boolean[] = [];
    const heard: boolean[] = [];
    worker.subscribe((e) => local.push(isRemoteEvent(e)));
    other.subscribe((e) => heard.push(isRemoteEvent(e)));

    await startRun(worker, 'wf', {}, 'run1');

    expect(local).toEqual([false, false, false, false]);
    expect(heard).toEqual([true, true, true, true]);
  });

  it('carry the mark outside their serialized form', () => {
    const event = markRemoteEvent({ type: 'run.started', runId: 'r', at: new Date(0) });
    expect(isRemoteEvent(event)).toBe(true);
    expect(Object.keys(event)).toEqual(['type', 'runId', 'at']);
    expect(JSON.parse(JSON.stringify(event))).toEqual({
      type: 'run.started',
      runId: 'r',
      at: new Date(0).toISOString(),
    });
  });

  it('are counted once, by the instance that produced them', async () => {
    const { worker, other } = twoInstances();
    const onWorker = collectMetrics(worker);
    const onOther = collectMetrics(other);

    await startRun(worker, 'wf', {}, 'run1');

    expect(onWorker.snapshot().runs.started).toBe(1);
    expect(onOther.snapshot().runs.started).toBe(0);
  });
});
