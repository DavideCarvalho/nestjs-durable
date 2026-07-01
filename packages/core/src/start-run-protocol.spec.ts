import { WorkflowEngine } from './engine';
import type { Heartbeat, StartRunMessage, StepResult, Transport } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A transport that carries the control-plane `start-run` channel: it captures the registered
 * `onStartRun` handler so a test can deliver a {@link StartRunMessage} exactly as a real broker
 * consumer would, driving the engine's tenant-namespaced run creation.
 */
class StartRunTransport implements Transport {
  private startRunHandler?: (message: StartRunMessage) => Promise<void>;

  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  onStartRun(handler: (message: StartRunMessage) => Promise<void>): void {
    this.startRunHandler = handler;
  }

  /** Simulate a broker delivering a start-run message to the registered consumer. */
  async deliver(message: StartRunMessage): Promise<void> {
    if (!this.startRunHandler) throw new Error('no onStartRun handler was registered');
    await this.startRunHandler(message);
  }
}

describe('WorkflowEngine — start-run protocol', () => {
  it('a start-run message stamps the run with the message tenant as its namespace', async () => {
    const store = new InMemoryStateStore();
    const transport = new StartRunTransport();
    const engine = new WorkflowEngine({ store, transport, namespace: 'control-plane' });
    // Register a local body so `start` resolves the workflow (the run is created, not routed remotely).
    engine.register('processing', '1', async (_ctx, input) => input);

    await transport.deliver({ tenant: 't1', workflow: 'processing', input: { hello: 'world' } });

    // The run is created under the tenant's namespace, NOT the engine's own 'control-plane'.
    const runs = await store.listRuns({});
    expect(runs).toHaveLength(1);
    const created = runs[0];
    expect(created?.namespace).toBe('t1');
    expect(created?.workflow).toBe('processing');
    expect(created?.input).toEqual({ hello: 'world' });
  });

  it('honors a caller-supplied runId and tags from the start-run message', async () => {
    const store = new InMemoryStateStore();
    const transport = new StartRunTransport();
    const engine = new WorkflowEngine({ store, transport, namespace: 'control-plane' });
    engine.register('processing', '1', async (_ctx, input) => input);

    await transport.deliver({
      tenant: 't2',
      workflow: 'processing',
      input: {},
      runId: 'run-fixed',
      tags: ['batch:nightly'],
    });

    const created = await store.getRun('run-fixed');
    expect(created?.namespace).toBe('t2');
    expect(created?.tags).toContain('batch:nightly');
  });

  it('the default start path still stamps the engine namespace', async () => {
    const store = new InMemoryStateStore();
    const transport = new StartRunTransport();
    const engine = new WorkflowEngine({ store, transport, namespace: 'control-plane' });
    engine.register('processing', '1', async (_ctx, input) => input);

    // No opts.namespace → the run inherits the engine's own namespace.
    await engine.start('processing', {}, 'run-default');

    const created = await store.getRun('run-default');
    expect(created?.namespace).toBe('control-plane');
  });
});
