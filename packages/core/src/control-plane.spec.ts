import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

// Two engines sharing one transport + store stand in for two pods (e.g. a worker pod that runs the
// workflow and an API/dashboard pod that only observes).
function twoInstances() {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const worker = new WorkflowEngine({ store, transport, instanceId: 'worker' });
  const dashboard = new WorkflowEngine({ store, transport, instanceId: 'dashboard' });
  return { store, transport, worker, dashboard };
}

describe('Transport control plane', () => {
  it('broadcasts lifecycle events to other instances (cross-pod live-tail)', async () => {
    const { worker, dashboard } = twoInstances();

    const onWorker: string[] = [];
    const onDashboard: string[] = [];
    worker.subscribe((e) => onWorker.push(e.type));
    dashboard.subscribe((e) => onDashboard.push(e.type));

    worker.register('wf', '1', async (ctx) => {
      await ctx.step('a', async () => 1);
      return 'ok';
    });
    await worker.start('wf', {}, 'run1');

    // The dashboard pod, which never executed anything, still sees the run's events.
    expect(onDashboard).toEqual(['run.started', 'step.completed', 'run.completed']);
    // And the worker delivered each event exactly once (no echo duplicate from its own publish).
    expect(onWorker).toEqual(['run.started', 'step.completed', 'run.completed']);
  });

  it('delivers cancellation to the instance running the work (cooperative cancel)', async () => {
    const { worker, dashboard } = twoInstances();
    const aborted: string[] = [];
    worker.onCancel((runId) => aborted.push(runId));

    worker.register('wf', '1', async (ctx) => ctx.waitForSignal('go'));
    await worker.start('wf', {}, 'run1'); // suspends, "work" notionally in flight on the worker

    // Cancel issued from the dashboard pod reaches the worker pod's cancel listener.
    await dashboard.cancel('run1');
    expect(aborted).toEqual(['run1']);
  });

  it('degrades to local-only events when the transport has no control plane', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store }); // no transport at all
    const seen: string[] = [];
    engine.subscribe((e) => seen.push(e.type));
    engine.register('wf', '1', async () => 'ok');
    await engine.start('wf', {}, 'run1');
    expect(seen).toEqual(['run.started', 'run.completed']);
  });
});
