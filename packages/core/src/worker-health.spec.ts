import { WorkflowEngine } from './engine';
import type { GroupHealth, RunQueueOptions, Transport, WorkerHeartbeat } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/** A transport that reports canned worker-health — exercises the engine's aggregation, not a broker. */
class HealthTransport implements Transport {
  constructor(
    private readonly health: Record<string, GroupHealth>,
    private readonly discovered: string[],
  ) {}
  async dispatch(): Promise<void> {}
  onResult(): void {}
  onHeartbeat(): void {}
  async groupHealth(group: string): Promise<GroupHealth> {
    return this.health[group] ?? { group, depth: 0, liveWorkers: [] };
  }
  async listWorkerGroups(): Promise<string[]> {
    return this.discovered;
  }
}

describe('engine.workerHealth', () => {
  it('covers registered groups (even with zero workers) UNION groups discovered from heartbeats', async () => {
    const store = new InMemoryStateStore();
    const transport = new HealthTransport(
      {
        // Registered remote group with backlog and NO live worker — the alert case.
        'processing-workflows': { group: 'processing-workflows', depth: 3, liveWorkers: [] },
        // Local-step group, not a registration — only known via its live heartbeats.
        pipeline: {
          group: 'pipeline',
          depth: 0,
          liveWorkers: [{ group: 'pipeline', instanceId: 'ts-h-1', lastBeatAt: 1700 }],
        },
      },
      ['pipeline'],
    );
    const engine = new WorkflowEngine({ store, transport });
    engine.registerRemote('processing', '1', {
      group: 'processing-workflows',
      executor: {
        async advance(run) {
          return { taskId: 't', runId: run.id, status: 'completed', commands: [], output: {} };
        },
      },
    });

    const health = await engine.workerHealth();
    const byGroup = new Map(health.map((h) => [h.group, h]));

    const proc = byGroup.get('processing-workflows');
    expect(proc?.depth).toBe(3);
    expect(proc?.liveWorkers).toHaveLength(0); // registered group surfaces even with no workers
    expect((proc?.depth ?? 0) > 0 && (proc?.liveWorkers.length ?? 0) === 0).toBe(true); // alert state

    const pipeline = byGroup.get('pipeline'); // discovered purely from heartbeats
    expect(pipeline?.liveWorkers).toHaveLength(1);
  });

  it('is empty when the transport cannot introspect health', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    expect(await engine.workerHealth()).toEqual([]);
  });

  it('classifies each group workflow-vs-step from the registry', async () => {
    const store = new InMemoryStateStore();
    const transport = new HealthTransport(
      {
        // a local `@Workflow` name, served on a partition
        'pipeline@davi-local': { group: 'pipeline@davi-local', depth: 0, liveWorkers: [] },
        // a `@Step` (Class.method) — not a registered workflow
        'PipelineWorkflow.bustBaseCache': {
          group: 'PipelineWorkflow.bustBaseCache',
          depth: 0,
          liveWorkers: [],
        },
        // a remote workflow whose GROUP differs from its name
        'processing-workflows': { group: 'processing-workflows', depth: 0, liveWorkers: [] },
        // a remote step handler
        handle_mel_dep_procs: { group: 'handle_mel_dep_procs', depth: 0, liveWorkers: [] },
      },
      ['pipeline@davi-local', 'PipelineWorkflow.bustBaseCache', 'handle_mel_dep_procs'],
    );
    const engine = new WorkflowEngine({ store, transport });
    engine.register('pipeline', '1', async () => ({}));
    engine.registerRemote('processing', '1', {
      group: 'processing-workflows',
      executor: {
        async advance(run) {
          return { taskId: 't', runId: run.id, status: 'completed', commands: [], output: {} };
        },
      },
    });

    const kindByGroup = new Map((await engine.workerHealth()).map((h) => [h.group, h.kind]));
    expect(kindByGroup.get('pipeline@davi-local')).toBe('workflow'); // local workflow, partitioned
    expect(kindByGroup.get('processing-workflows')).toBe('workflow'); // remote, group ≠ name
    expect(kindByGroup.get('PipelineWorkflow.bustBaseCache')).toBe('step');
    expect(kindByGroup.get('handle_mel_dep_procs')).toBe('step');
  });

  it('covers the group of an in-flight PENDING remote step, even with no registration and no heartbeat', async () => {
    const store = new InMemoryStateStore();
    // The tenant's step queue: it has the stuck job (depth 1) and NO live worker — the exact signal a
    // run waiting on an offline tenant produces. The group is neither a registration nor heartbeating,
    // so it is discoverable ONLY from the in-flight run's pending checkpoint.
    const transport = new HealthTransport(
      { 'ingest@jordi-local': { group: 'ingest@jordi-local', depth: 1, liveWorkers: [] } },
      [], // no live heartbeats anywhere
    );
    const engine = new WorkflowEngine({ store, transport });

    const now = new Date();
    await store.createRun({
      id: 'r1',
      workflow: 'pipeline',
      workflowVersion: '1',
      status: 'suspended',
      namespace: 'jordi-local',
      input: {},
      createdAt: now,
      updatedAt: now,
    });
    await store.saveCheckpoint({
      runId: 'r1',
      seq: 0,
      name: 'ingest',
      kind: 'remote',
      status: 'pending',
      attempts: 1,
      workerGroup: 'ingest@jordi-local',
      startedAt: now,
      finishedAt: now,
      enqueuedAt: now,
    });

    const health = await engine.workerHealth();
    const stuck = health.find((h) => h.group === 'ingest@jordi-local');
    expect(stuck?.depth).toBe(1);
    expect(stuck?.liveWorkers).toHaveLength(0); // depth>0, no worker -> the dashboard's no-worker state
    expect(stuck?.kind).toBe('step');
  });
});

/** {@link HealthTransport} that also carries a run queue whose live consumers it reports. */
class RunQueueHealthTransport extends HealthTransport {
  readonly asked: (string | undefined)[] = [];
  constructor(
    health: Record<string, GroupHealth>,
    discovered: string[],
    private readonly consumers: WorkerHeartbeat[],
  ) {
    super(health, discovered);
  }
  async dispatchRuns(): Promise<void> {}
  onDispatchedRun(): () => Promise<void> {
    return async () => undefined;
  }
  async liveRunConsumers(opts?: RunQueueOptions): Promise<WorkerHeartbeat[]> {
    this.asked.push(opts?.namespace);
    return this.consumers;
  }
}

const consumer = (instanceId: string, lastBeatAt = 1700): WorkerHeartbeat => ({
  group: '',
  instanceId,
  lastBeatAt,
  status: { runtime: 'node', concurrency: { mode: 'fixed', limit: 4 }, inFlight: 1 },
});

describe('engine.workerHealth — a control plane running its own workflows', () => {
  it('reports the run-queue consumers as the live workers of its in-process workflows', async () => {
    const transport = new RunQueueHealthTransport({}, [], [consumer('ts-hub-1')]);
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('relay', '1', async () => ({}));

    const health = await engine.workerHealth();
    const relay = health.find((h) => h.group === 'relay');
    expect(relay?.kind).toBe('workflow');
    expect(relay?.liveWorkers).toEqual([{ ...consumer('ts-hub-1'), group: 'relay' }]);
  });

  it("names each workflow under the engine's namespace, and asks for that namespace's consumers", async () => {
    const transport = new RunQueueHealthTransport({}, [], [consumer('ts-hub-1')]);
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport,
      namespace: 'davi-local',
    });
    engine.register('relay:tick', '1', async () => ({}));

    const health = await engine.workerHealth();
    expect(health.map((h) => h.group)).toEqual(['relay-tick@davi-local']);
    expect(transport.asked).toEqual(['davi-local']);
  });

  it('reports nothing extra while no instance consumes the run queue', async () => {
    const transport = new RunQueueHealthTransport({}, [], []);
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('relay', '1', async () => ({}));
    expect(await engine.workerHealth()).toEqual([]);
  });

  it('leaves a group-served (remote) workflow to the workers that heartbeat on its queue', async () => {
    const transport = new RunQueueHealthTransport(
      { 'processing-workflows': { group: 'processing-workflows', depth: 2, liveWorkers: [] } },
      [],
      [consumer('ts-hub-1')],
    );
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.registerRemote('processing', '1', {
      group: 'processing-workflows',
      executor: {
        async advance(run) {
          return { taskId: 't', runId: run.id, status: 'completed', commands: [], output: {} };
        },
      },
    });

    const health = await engine.workerHealth();
    // Still the alert state: the engine does not execute this body, so it is no worker for it.
    expect(health).toEqual([
      { group: 'processing-workflows', depth: 2, liveWorkers: [], kind: 'workflow' },
    ]);
    // With no in-process workflow to report them under, the consumers are not even read.
    expect(transport.asked).toEqual([]);
  });

  it('does not list an instance twice when it also heartbeats on the queue', async () => {
    const beat: WorkerHeartbeat = { group: 'relay', instanceId: 'ts-hub-1', lastBeatAt: 1800 };
    const transport = new RunQueueHealthTransport(
      { relay: { group: 'relay', depth: 0, liveWorkers: [beat] } },
      ['relay'],
      [consumer('ts-hub-1'), consumer('ts-hub-2')],
    );
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('relay', '1', async () => ({}));

    const [relay] = await engine.workerHealth();
    expect(relay?.liveWorkers.map((w) => w.instanceId)).toEqual(['ts-hub-1', 'ts-hub-2']);
  });
});
