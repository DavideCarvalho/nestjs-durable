import { WorkflowEngine } from './engine';
import type { WorkerDescriptor } from './handshake/index';
import type { Transport, WorkerHeartbeat } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { TransportPool } from './transport-pool';

/**
 * `engine.workflowDirectory()` — and the three states an empty `announcedWorkflows()` used to
 * collapse into one answer.
 *
 * The case that drove this: a Python worker on an SDK older than the descriptor advertisement beats
 * `durable-worker-heartbeat:processing:py-…` and publishes no descriptor at all. Reading only
 * descriptors reported that fleet as EMPTY while `resolveRemoteByConvention` — reading the very same
 * heartbeat keys — resolved `processing` and dispatched to it. These pin that the two agree.
 */

/** A transport that serves canned advertisement + liveness reads, without a broker. */
class FleetTransport implements Transport {
  constructor(
    private readonly descriptors: WorkerDescriptor[],
    private readonly beats: WorkerHeartbeat[] = [],
  ) {}
  async dispatch(): Promise<void> {}
  onResult(): void {}
  onHeartbeat(): void {}
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
  async readAllWorkerHeartbeats(): Promise<WorkerHeartbeat[]> {
    return this.beats;
  }
  async listWorkerGroups(): Promise<string[]> {
    return [...new Set(this.beats.map((b) => b.group))];
  }
}

/** A transport that can dispatch and nothing else — a pure in-process pool: it advertises nothing
 *  and scans nothing, so it cannot even be ASKED what the fleet holds. */
class BlindTransport implements Transport {
  async dispatch(): Promise<void> {}
  onResult(): void {}
  onHeartbeat(): void {}
}

function beat(group: string, instanceId: string): WorkerHeartbeat {
  return { group, instanceId, lastBeatAt: Date.now() };
}

function worker(over: Partial<WorkerDescriptor> & { instanceId: string }): WorkerDescriptor {
  return {
    runtime: 'node',
    sdk: { name: 'sdk', version: '1' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [],
    steps: [],
    startedAt: 0,
    ...over,
  };
}

describe('workflowDirectory — the three states', () => {
  it('a live worker that publishes NO descriptor is visible, not absent', async () => {
    // Exactly the deployed shape: heartbeats for the workflow token and for each step handler, and
    // not one descriptor key. The old read returned [] here.
    const transport = new FleetTransport(
      [],
      [
        beat('processing', 'py-host-10569'),
        beat('handle_MEL', 'py-host-10569'),
        beat('handle_SUBWO', 'py-host-10569'),
      ],
    );
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });

    const directory = await engine.workflowDirectory();
    expect(directory.supported).toBe(true);
    expect(directory.workflows.map((w) => w.key)).toEqual([
      'handle_MEL',
      'handle_SUBWO',
      'processing',
    ]);
    // `announcedWorkflows` is the same answer — the surface a picker already calls gets the fix.
    expect((await engine.announcedWorkflows()).map((w) => w.key)).toEqual(
      directory.workflows.map((w) => w.key),
    );
  });

  it('states nothing an observation cannot know — no version, origin or runtime', async () => {
    const transport = new FleetTransport([], [beat('processing', 'py-host-10569')]);
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });

    const [entry] = (await engine.workflowDirectory()).workflows;
    expect(entry?.evidence).toBe('observed');
    expect(entry?.version).toBeUndefined();
    expect(entry?.origins).toEqual([]);
    expect(entry?.requires).toEqual([]);
    // A heartbeat does not say what wrote it. `py-…` is a convention, not a statement.
    expect(entry?.runtimes).toEqual([]);
    // What it DOES establish: the queue a call would land on, and who is consuming it.
    expect(entry?.groups).toEqual(['processing']);
    expect(entry?.instances).toEqual(['py-host-10569']);
    expect((await engine.workflowDirectory()).detail).toContain('cannot be checked');
  });

  it('a token a worker DECLARED as a step is not offered as a workflow', async () => {
    // Route-by-handler gives every step its own queue, so the heartbeat keyspace of a healthy fleet
    // is mostly step tokens. Measured against a live deployment, the liveness floor without this
    // turned 40+ step handlers into fake callable workflows.
    const transport = new FleetTransport(
      [
        worker({
          instanceId: 'ts-1',
          steps: ['ExportService.runExport', 'ExportService.markError'],
        }),
      ],
      [
        beat('ExportService.runExport', 'ts-1'),
        beat('ExportService.markError', 'ts-1'),
        beat('processing', 'py-1'),
      ],
    );
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });

    const { workflows } = await engine.workflowDirectory();
    // Only the one nobody declared as anything survives — and it survives BECAUSE nobody declared it.
    expect(workflows.map((w) => w.key)).toEqual(['processing']);
  });

  it('a descriptor always wins — a described worker is never re-counted as an observation', async () => {
    const transport = new FleetTransport(
      [
        worker({
          instanceId: 'py-1',
          runtime: 'python',
          registrations: [{ name: 'processing', version: '2', group: 'processing' }],
        }),
      ],
      [beat('processing', 'py-1')],
    );
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });

    const { workflows } = await engine.workflowDirectory();
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.evidence).toBe('declared');
    expect(workflows[0]?.key).toBe('processing@2');
    expect(workflows[0]?.runtimes).toEqual(['python']);
  });

  it('distinguishes "nothing is live" from "nobody asked"', async () => {
    const asked = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new FleetTransport([], []),
    });
    const empty = await asked.workflowDirectory();
    expect(empty.supported).toBe(true);
    expect(empty.workflows).toEqual([]);
    expect(empty.detail).toContain('nothing is live');

    const blind = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new BlindTransport(),
    });
    const unasked = await blind.workflowDirectory();
    // The SAME empty array, and it means something entirely different — which is the whole point.
    expect(unasked.supported).toBe(false);
    expect(unasked.workflows).toEqual([]);
    expect(unasked.detail).toContain('nothing here was asked');
  });

  it('a worker on ANOTHER partition is reported, not read as absence', async () => {
    // A worker that set a partition consumes `processing@acme`. An engine serving the bare partition
    // computes `processing`, misses, and used to conclude nothing was running at all.
    const transport = new FleetTransport([], [beat('processing@acme', 'py-acme-1')]);
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport,
      namespace: 'default',
    });

    const directory = await engine.workflowDirectory();
    expect(directory.workflows).toEqual([]);
    expect(directory.otherPartitions).toEqual([
      { partition: 'acme', groups: ['processing@acme'], instances: ['py-acme-1'] },
    ]);
    expect(directory.detail).toContain('acme');
    expect(directory.detail).toContain('wrong partition');
  });

  it('an operator (no namespace) serves every partition, so none is foreign to it', async () => {
    const transport = new FleetTransport(
      [],
      [beat('processing', 'py-1'), beat('processing@acme', 'py-acme-1')],
    );
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });

    const directory = await engine.workflowDirectory();
    expect(directory.otherPartitions).toEqual([]);
    expect(directory.workflows.map((w) => w.key)).toEqual(['processing', 'processing@acme']);
  });

  it('de-duplicates one worker seen through two transports in the pool', async () => {
    const pool = new TransportPool([
      { id: 'a', transport: new FleetTransport([], [beat('processing', 'py-1')]) },
      { id: 'b', transport: new FleetTransport([], [beat('processing', 'py-1')]) },
    ]);
    expect(await pool.readAllWorkerHeartbeats()).toHaveLength(1);
    expect(pool.introspectsFleet).toBe(true);
    expect(new TransportPool([{ id: 'a', transport: new BlindTransport() }]).introspectsFleet).toBe(
      false,
    );
  });
});
