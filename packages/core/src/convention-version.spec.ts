import { VERSION_UNDECLARED_TAG, WorkflowEngine } from './engine';
import type { WorkerDescriptor } from './handshake/index';
import type { RemoteTask, StepResult, Transport, WorkflowTask } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * What version a CONVENTION-RESOLVED remote run records.
 *
 * The bug: `start` built the synthetic run stamped `workflowVersion: '1'` BEFORE calling
 * `resolveRemoteByConvention`, which echoed it straight back as the registration's version, and the
 * run row was written from that. So the row recorded a version nothing had observed, and any check
 * comparing an authored pin against it passed on `'1'` and failed on everything else — whatever the
 * worker actually was. A check that cannot fail is worse than no check.
 *
 * The version now comes FROM THE FLEET, and when the fleet declares none the run says so instead of
 * quietly wearing a number nobody chose.
 */

/** A transport with a live `processing` group, optionally advertising descriptors for it. */
class ConventionTransport implements Transport {
  readonly dispatched: WorkflowTask[] = [];
  constructor(
    private readonly groups: string[],
    private readonly descriptors: WorkerDescriptor[] = [],
  ) {}
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(): void {}
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.dispatched.push(task);
  }
  onDecision(): void {}
  async listWorkerGroups(): Promise<string[]> {
    return this.groups;
  }
  async readWorkerDescriptors(group: string): Promise<WorkerDescriptor[]> {
    return this.descriptors.filter((d) => d.registrations?.some((r) => r.group === group));
  }
}

function pythonWorker(registrations: WorkerDescriptor['registrations']): WorkerDescriptor {
  return {
    instanceId: 'py-1',
    runtime: 'python',
    sdk: { name: 'durable-worker', version: '0.23.0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: (registrations ?? []).map((r) => r.name),
    steps: [],
    startedAt: 0,
    ...(registrations ? { registrations } : {}),
  };
}

describe('a convention-resolved remote records the version the FLEET declares', () => {
  it("uses the announced version — a pin of '1' can now genuinely fail", async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport(
      ['processing'],
      [pythonWorker([{ name: 'processing', version: '2', group: 'processing' }])],
    );
    const engine = new WorkflowEngine({ store, transport });

    await engine.start('processing', { proc: 'all' }, 'run-1');

    const run = await engine.getRun('run-1');
    // Was '1' by construction. It is now what the worker says it serves.
    expect(run?.workflowVersion).toBe('2');
    expect(run?.tags ?? []).not.toContain(VERSION_UNDECLARED_TAG);
  });

  it('says so when the fleet declares NO version, instead of wearing an invented one', async () => {
    const store = new InMemoryStateStore();
    // The deployed shape: a live group, and a worker too old to publish a descriptor for it.
    const engine = new WorkflowEngine({
      store,
      transport: new ConventionTransport(['processing']),
    });

    await engine.start('processing', { proc: 'all' }, 'run-2');

    const run = await engine.getRun('run-2');
    // The routing default is kept — refusing the call outright would make an un-upgraded callee
    // UNCALLABLE, which is the failure this ecosystem refuses harder than an unenforceable pin.
    expect(run?.workflowVersion).toBe('1');
    // …but the run carries the fact, so a pin check reads "nobody stated this" rather than a match.
    expect(run?.tags).toContain(VERSION_UNDECLARED_TAG);
  });

  it('treats two workers disagreeing about the version as undeclared, not as a coin flip', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport(
      ['processing'],
      [
        pythonWorker([{ name: 'processing', version: '2', group: 'processing' }]),
        {
          ...pythonWorker([{ name: 'processing', version: '3', group: 'processing' }]),
          instanceId: 'py-2',
        },
      ],
    );
    const engine = new WorkflowEngine({ store, transport });

    await engine.start('processing', {}, 'run-3');

    const run = await engine.getRun('run-3');
    expect(run?.workflowVersion).toBe('1');
    expect(run?.tags).toContain(VERSION_UNDECLARED_TAG);
  });

  it('leaves an explicitly registered remote alone — only convention resolution asks the fleet', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport(
      ['processing'],
      [pythonWorker([{ name: 'processing', version: '9', group: 'processing' }])],
    );
    const engine = new WorkflowEngine({ store, transport });
    engine.registerRemote('processing', '4', {
      group: 'processing',
      // Enqueues nothing and never replies (the run just suspends awaiting a turn that never comes);
      // this test is about the version the ROW records at start, not about advancing it.
      executor: { dispatch: async () => {} },
    });

    await engine.start('processing', {}, 'run-4');

    const run = await engine.getRun('run-4');
    // The author's registration is the statement here; the fleet does not get to overrule it.
    expect(run?.workflowVersion).toBe('4');
    expect(run?.tags ?? []).not.toContain(VERSION_UNDECLARED_TAG);
  });

  it('a resumed run stays pinned to the version it began on, however the fleet has moved', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport(['processing']);
    const engine = new WorkflowEngine({ store, transport });
    await engine.start('processing', {}, 'run-5');

    // The fleet re-deploys and now declares a version. Replay is positional: the in-flight run must
    // NOT be re-pointed mid-flight by a read that happens to run later.
    const moved = new ConventionTransport(
      ['processing'],
      [pythonWorker([{ name: 'processing', version: '7', group: 'processing' }])],
    );
    const after = new WorkflowEngine({ store, transport: moved });
    await after.resume('run-5');

    expect((await after.getRun('run-5'))?.workflowVersion).toBe('1');
  });
});
