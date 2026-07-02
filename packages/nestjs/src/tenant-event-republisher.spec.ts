import type { EngineEvent, TenantEvent, WorkflowRun } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it, vi } from 'vitest';
import { type RunLookupStore, TenantEventRepublisher } from './tenant-event-republisher';

function fakeRun(id: string, namespace: string): WorkflowRun {
  return {
    id,
    workflow: 'wf',
    workflowVersion: '1',
    status: 'running',
    input: null,
    namespace,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** A `step.*` event never carries `namespace` (only `run.*` lifecycle events are stamped — see
 *  `EngineEvent.namespace`), so every fixture below omits it to force the republisher through its
 *  `store.getRun` fallback path — the one that must respect the cache/eviction contract. */
function stepEvent(type: EngineEvent['type'], runId: string): EngineEvent {
  return { type, runId, at: new Date() };
}

function fakeStore(namespace: string): RunLookupStore & { getRun: ReturnType<typeof vi.fn> } {
  return {
    getRun: vi.fn(async (id: string) => fakeRun(id, namespace)),
  };
}

function fakePublish(): {
  publish: (event: TenantEvent) => Promise<void>;
  published: TenantEvent[];
} {
  const published: TenantEvent[] = [];
  return {
    publish: async (event: TenantEvent) => {
      published.push(event);
    },
    published,
  };
}

describe('TenantEventRepublisher', () => {
  it('evicts the namespace cache on a terminal event, forcing a fresh store.getRun for the next event of that run', async () => {
    const store = fakeStore('acme');
    const { publish } = fakePublish();
    const republisher = new TenantEventRepublisher(store, publish);

    await republisher.handle(stepEvent('step.started', 'r1')); // cache miss -> getRun #1, cached
    await republisher.handle(stepEvent('run.completed', 'r1')); // cache hit, then evicted (terminal)
    await republisher.handle(stepEvent('step.progress', 'r1')); // cache miss again -> getRun #2

    expect(store.getRun).toHaveBeenCalledTimes(2);
  });

  it('keeps an in-flight (non-terminal) run cached across multiple step events — one store.getRun total', async () => {
    const store = fakeStore('acme');
    const { publish } = fakePublish();
    const republisher = new TenantEventRepublisher(store, publish);

    await republisher.handle(stepEvent('step.started', 'r2'));
    await republisher.handle(stepEvent('step.progress', 'r2'));
    await republisher.handle(stepEvent('step.completed', 'r2'));

    expect(store.getRun).toHaveBeenCalledTimes(1);
  });

  it('never caches a bare/default-namespace run, so its slot is never occupied in the first place', async () => {
    const store = fakeStore('default');
    const { publish, published } = fakePublish();
    const republisher = new TenantEventRepublisher(store, publish);

    await republisher.handle(stepEvent('step.started', 'r3'));
    await republisher.handle(stepEvent('step.progress', 'r3'));

    // No cache slot was ever consumed for the bare run, so every event re-resolves via the store.
    expect(store.getRun).toHaveBeenCalledTimes(2);
    // And a bare/default namespace is never re-published — it's operator noise, not a tenant's run.
    expect(published).toHaveLength(0);
  });

  it('still resolves and caches a genuine tenant namespace stamped directly on the event (run.* path)', async () => {
    const store = fakeStore('should-not-be-read');
    const { publish, published } = fakePublish();
    const republisher = new TenantEventRepublisher(store, publish);

    await republisher.handle({
      type: 'run.started',
      runId: 'r4',
      namespace: 'acme',
      at: new Date(),
    });
    await republisher.handle(stepEvent('step.progress', 'r4')); // no namespace on the event -> cache hit

    expect(store.getRun).not.toHaveBeenCalled();
    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({ tenant: 'acme' });
    expect(published[1]).toMatchObject({ tenant: 'acme' });
  });
});
