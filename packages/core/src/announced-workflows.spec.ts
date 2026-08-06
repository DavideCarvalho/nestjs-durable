import { WorkflowEngine } from './engine';
import type { WorkerDescriptor } from './handshake/index';
import type { Transport } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';
import { TransportPool } from './transport-pool';

/**
 * `engine.announcedWorkflows()` — the deployment-wide registry a picker reads. The engine's OWN
 * registry cannot answer this (a missing body means "not here", "remote elsewhere", or "resolved by
 * convention" indistinguishably), so these exercise the property that matters: the answer comes from
 * what live workers announced, and it does not change with which pod is asked.
 */

/** A transport that serves canned live descriptors — the advertisement keyspace, without a broker. */
class AdvertisingTransport implements Transport {
  constructor(private readonly descriptors: WorkerDescriptor[]) {}
  async dispatch(): Promise<void> {}
  onResult(): void {}
  onHeartbeat(): void {}
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
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

describe('engine.announcedWorkflows', () => {
  it("answers from the live fleet, NOT from this engine's own registrations", async () => {
    const store = new InMemoryStateStore();
    const transport = new AdvertisingTransport([
      worker({
        instanceId: 'py-1',
        runtime: 'python',
        registrations: [{ name: 'pipeline', version: '2', group: 'pipeline' }],
      }),
    ]);
    const engine = new WorkflowEngine({ store, transport });
    // This engine holds a body for a DIFFERENT workflow and knows nothing about `pipeline`. Neither
    // fact moves the registry: `local` is not announced (no worker consumes a queue for it here),
    // and `pipeline` is, because a live Python worker says it serves it.
    engine.register('local', '1', async () => 1);

    const announced = await engine.announcedWorkflows();
    expect(announced.map((a) => a.key)).toEqual(['pipeline@2']);
    expect(announced[0]?.runtimes).toEqual(['python']);
    expect(announced[0]?.groups).toEqual(['pipeline']);
  });

  it('is empty when the transport cannot introspect the advertisement keyspace', async () => {
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    engine.register('local', '1', async () => 1);
    expect(await engine.announcedWorkflows()).toEqual([]);
  });

  it("scopes to this engine's namespace, treating an unstated namespace as `default`", async () => {
    const store = new InMemoryStateStore();
    const transport = new AdvertisingTransport([
      worker({ instanceId: 'w-acme', namespace: 'acme', registrations: [{ name: 'acme-only' }] }),
      worker({ instanceId: 'w-bare', registrations: [{ name: 'shared' }] }),
    ]);

    const tenant = new WorkflowEngine({ store, transport, namespace: 'acme' });
    expect((await tenant.announcedWorkflows()).map((a) => a.key)).toEqual(['acme-only']);

    const single = new WorkflowEngine({ store, transport, namespace: 'default' });
    expect((await single.announcedWorkflows()).map((a) => a.key)).toEqual(['shared']);
  });

  it('an operator (no namespace) sees every tenant — "ver tudo = ausência de namespace"', async () => {
    const transport = new AdvertisingTransport([
      worker({ instanceId: 'w-acme', namespace: 'acme', registrations: [{ name: 'acme-only' }] }),
      worker({ instanceId: 'w-bare', registrations: [{ name: 'shared' }] }),
    ]);
    const operator = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    expect((await operator.announcedWorkflows()).map((a) => a.key)).toEqual([
      'acme-only',
      'shared',
    ]);
  });

  it('carries a disagreement through instead of resolving it for the caller', async () => {
    const transport = new AdvertisingTransport([
      worker({ instanceId: 'w1', registrations: [{ name: 'p', version: '1', origin: 'flip' }] }),
      worker({ instanceId: 'w2', registrations: [{ name: 'p', version: '1', origin: 'acme' }] }),
    ]);
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    const [entry] = await engine.announcedWorkflows();
    expect(entry?.origins).toEqual(['acme', 'flip']);
    expect(entry?.disagreements).toEqual([{ axis: 'origin', values: ['acme', 'flip'] }]);
  });

  it('drops a worker that stopped announcing — a dead worker offers nothing', async () => {
    // Liveness is the descriptor key's TTL: the transport returns only keys that have not expired,
    // so "the worker died" arrives here as "the descriptor is no longer returned".
    const live: WorkerDescriptor[] = [
      worker({ instanceId: 'py-1', runtime: 'python', registrations: [{ name: 'pipeline' }] }),
    ];
    const transport: Transport = {
      async dispatch(): Promise<void> {},
      onResult(): void {},
      onHeartbeat(): void {},
      async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
        return live;
      },
    };
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    expect(await engine.announcedWorkflows()).toHaveLength(1);

    live.length = 0; // the key expired
    expect(await engine.announcedWorkflows()).toEqual([]);
  });
});

describe('engine.announcedWorkflows — across a transport pool', () => {
  it('merges every transport and counts an instance once, however many times it is read', async () => {
    // A mixed pool (e.g. a namespaced transport paired with a bare-prefix one for operator-convention
    // tenant workers) can surface the SAME worker twice. It is one worker, so it counts once.
    const shared = worker({
      instanceId: 'py-1',
      runtime: 'python',
      registrations: [{ name: 'pipeline', version: '2' }],
    });
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transports: [
        { id: 'a', transport: new AdvertisingTransport([shared]) },
        {
          id: 'b',
          transport: new AdvertisingTransport([
            shared,
            worker({ instanceId: 'ts-1', registrations: [{ name: 'local-only' }] }),
          ]),
        },
        // A transport that cannot introspect the keyspace contributes nothing, never an error.
        { id: 'c', transport: new InMemoryTransport() },
      ],
    });

    const announced = await engine.announcedWorkflows();
    expect(announced.map((a) => a.key)).toEqual(['local-only', 'pipeline@2']);
    expect(announced.find((a) => a.key === 'pipeline@2')?.instances).toEqual(['py-1']);
  });
});

describe('TransportPool.readAllWorkerDescriptors', () => {
  it('hands the caller ONE copy per worker, whichever transports surfaced it', () => {
    // A mixed pool can see the same worker on more than one transport, and one transport can see it
    // under several tokens. The reader downstream should not have to know that.
    const shared = worker({ instanceId: 'py-1', registrations: [{ name: 'pipeline' }] });
    const pool = new TransportPool([
      { id: 'a', transport: new AdvertisingTransport([shared, shared]) },
      { id: 'b', transport: new AdvertisingTransport([shared]) },
      { id: 'c', transport: new InMemoryTransport() },
    ]);
    return pool.readAllWorkerDescriptors().then((descriptors) => {
      expect(descriptors.map((d) => d.instanceId)).toEqual(['py-1']);
    });
  });

  it('is empty — never an error — when no transport can introspect the keyspace', async () => {
    const pool = new TransportPool([{ id: 'a', transport: new InMemoryTransport() }]);
    expect(await pool.readAllWorkerDescriptors()).toEqual([]);
  });
});
