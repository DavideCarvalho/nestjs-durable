import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, RemoteTask, StepResult, Transport } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/** A transport that records every `useNamespace` call so we can assert the engine propagated its own. */
class SpyTransport implements Transport {
  readonly namespaces: string[] = [];
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (b: Heartbeat) => Promise<void>): void {}
  useNamespace(namespace: string): void {
    this.namespaces.push(namespace);
  }
}

describe('engine → transport namespace propagation', () => {
  it('propagates a non-default namespace to a single transport', () => {
    const transport = new SpyTransport();
    new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport,
      namespace: 'dev-alice',
    });
    expect(transport.namespaces).toEqual(['dev-alice']);
  });

  it('propagates "default" too (the transport itself makes default a no-op)', () => {
    const transport = new SpyTransport();
    new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    expect(transport.namespaces).toEqual(['default']);
  });

  it('propagates the namespace to every transport in a pool', () => {
    const a = new SpyTransport();
    const b = new SpyTransport();
    new WorkflowEngine({
      store: new InMemoryStateStore(),
      transports: [
        { id: 'a', transport: a },
        { id: 'b', transport: b },
      ],
      namespace: 'dev-alice',
    });
    expect(a.namespaces).toEqual(['dev-alice']);
    expect(b.namespaces).toEqual(['dev-alice']);
  });

  it('does not throw when there are no transports', () => {
    expect(
      () => new WorkflowEngine({ store: new InMemoryStateStore(), namespace: 'dev-alice' }),
    ).not.toThrow();
  });
});
