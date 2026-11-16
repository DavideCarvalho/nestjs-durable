import { describe, expect, it } from 'vitest';
import type { EngineEvent } from './interfaces';
import {
  type AttributedEngineEvent,
  RunAppStamper,
  controlPlaneAttribution,
  runTraceId,
  tenantAppOf,
} from './run-app';

const at = new Date(0);
const ev = (type: EngineEvent['type'], runId: string, extra: Partial<EngineEvent> = {}) =>
  ({ type, runId, at, ...extra }) as EngineEvent;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('runTraceId', () => {
  it('is 32 lowercase hex, stable per run, different across runs', () => {
    expect(runTraceId('r1')).toMatch(/^[0-9a-f]{32}$/);
    expect(runTraceId('r1')).toBe(runTraceId('r1'));
    expect(runTraceId('r1')).not.toBe(runTraceId('r2'));
  });
});

describe('tenantAppOf', () => {
  it('treats an absent, empty or default namespace and the own ones as the control plane', () => {
    expect(tenantAppOf(undefined)).toBeUndefined();
    expect(tenantAppOf('')).toBeUndefined();
    expect(tenantAppOf('default')).toBeUndefined();
    expect(tenantAppOf('ops', ['ops'])).toBeUndefined();
    expect(tenantAppOf('acme', ['ops'])).toBe('acme');
  });
});

describe('controlPlaneAttribution', () => {
  it('is undefined off a control plane', () => {
    const getRun = async () => null;
    expect(controlPlaneAttribution(undefined, getRun)).toBeUndefined();
    expect(controlPlaneAttribution({ topology: 'standalone' }, getRun)).toBeUndefined();
    expect(controlPlaneAttribution({ topology: 'tenant', partition: 'acme' }, getRun)).toBe(
      undefined,
    );
  });

  it('reads the namespace through getRun and names the own namespace', async () => {
    const attribution = controlPlaneAttribution(
      { topology: 'control-plane', namespace: 'ops', partition: 'ops' },
      async (id) => (id === 'r1' ? { namespace: 'acme' } : null),
    );
    expect(attribution?.own).toEqual(['ops', 'ops']);
    expect(await attribution?.namespaceOf('r1')).toBe('acme');
    expect(await attribution?.namespaceOf('missing')).toBeUndefined();
  });
});

describe('RunAppStamper', () => {
  it('stamps app (and namespace) on every event of a tenant run, step events included', async () => {
    const lookups: string[] = [];
    const stamper = new RunAppStamper({
      namespaceOf: async (id) => {
        lookups.push(id);
        return 'acme';
      },
    });
    const out: AttributedEngineEvent[] = [];
    stamper.stamp(ev('run.started', 'r1', { namespace: 'acme' }), (e) => out.push(e));
    stamper.stamp(ev('step.started', 'r1', { seq: 1, name: 's' }), (e) => out.push(e));
    stamper.stamp(ev('run.completed', 'r1', { namespace: 'acme' }), (e) => out.push(e));
    await flush();

    expect(out.map((e) => [e.type, e.app, e.namespace])).toEqual([
      ['run.started', 'acme', 'acme'],
      ['step.started', 'acme', 'acme'],
      ['run.completed', 'acme', 'acme'],
    ]);
    // The run event carried the partition: no read.
    expect(lookups).toEqual([]);
  });

  it('reads an unseen run once and keeps its events in order behind the read', async () => {
    const read = deferred<string | undefined>();
    let reads = 0;
    const stamper = new RunAppStamper({
      namespaceOf: () => {
        reads += 1;
        return read.promise;
      },
    });
    const out: string[] = [];
    stamper.stamp(ev('step.started', 'r1', { seq: 1 }), (e) => out.push(`${e.type}:${e.app}`));
    stamper.stamp(ev('step.completed', 'r1', { seq: 1 }), (e) => out.push(`${e.type}:${e.app}`));
    await flush();
    expect(out).toEqual([]);

    read.resolve('acme');
    await flush();
    expect(out).toEqual(['step.started:acme', 'step.completed:acme']);
    expect(reads).toBe(1);

    stamper.stamp(ev('step.started', 'r1', { seq: 2 }), (e) => out.push(`${e.type}:${e.app}`));
    expect(out.at(-1)).toBe('step.started:acme');
    expect(reads).toBe(1);
  });

  it("does not hold other runs' events behind one run's read", async () => {
    const read = deferred<string | undefined>();
    const stamper = new RunAppStamper({
      namespaceOf: (id) => (id === 'slow' ? read.promise : Promise.resolve('beta')),
    });
    const out: string[] = [];
    stamper.stamp(ev('step.started', 'slow'), (e) => out.push(`${e.runId}:${e.app}`));
    stamper.stamp(ev('run.started', 'fast', { namespace: 'beta' }), (e) =>
      out.push(`${e.runId}:${e.app}`),
    );
    expect(out).toEqual(['fast:beta']);
    read.resolve('acme');
    await flush();
    expect(out).toEqual(['fast:beta', 'slow:acme']);
  });

  it("leaves the control plane's own runs untouched", async () => {
    const stamper = new RunAppStamper({
      namespaceOf: async () => 'ops',
      own: ['ops'],
    });
    const out: AttributedEngineEvent[] = [];
    const own = ev('run.started', 'a', { namespace: 'ops' });
    const bare = ev('run.started', 'b');
    const dflt = ev('run.started', 'c', { namespace: 'default' });
    stamper.stamp(own, (e) => out.push(e));
    stamper.stamp(dflt, (e) => out.push(e));
    stamper.stamp(bare, (e) => out.push(e));
    stamper.stamp(ev('step.started', 'a'), (e) => out.push(e));
    await flush();
    expect(out).toHaveLength(4);
    for (const e of out) expect('app' in e).toBe(false);
    expect(out[0]).toBe(own);
    expect(out[1]).toBe(dflt);
  });

  it('forwards unattributed on a failed read and reads again on the next event', async () => {
    let calls = 0;
    const stamper = new RunAppStamper({
      namespaceOf: async () => {
        calls += 1;
        if (calls === 1) throw new Error('store down');
        return 'acme';
      },
    });
    const out: AttributedEngineEvent[] = [];
    stamper.stamp(ev('step.started', 'r1'), (e) => out.push(e));
    await flush();
    stamper.stamp(ev('step.completed', 'r1'), (e) => out.push(e));
    await flush();
    expect(out.map((e) => e.app)).toEqual([undefined, 'acme']);
    expect(calls).toBe(2);
  });

  it('forwards unattributed when a read times out, and does not cache it', async () => {
    let calls = 0;
    const stamper = new RunAppStamper({
      namespaceOf: () => {
        calls += 1;
        return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('acme');
      },
      lookupTimeoutMs: 5,
    });
    const out: AttributedEngineEvent[] = [];
    stamper.stamp(ev('step.started', 'r1'), (e) => out.push(e));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(out.map((e) => e.app)).toEqual([undefined]);
    stamper.stamp(ev('step.completed', 'r1'), (e) => out.push(e));
    await flush();
    expect(out.map((e) => e.app)).toEqual([undefined, 'acme']);
  });

  it('a throwing forward does not stall the events behind it', async () => {
    const read = deferred<string | undefined>();
    const stamper = new RunAppStamper({ namespaceOf: () => read.promise });
    const out: string[] = [];
    stamper.stamp(ev('step.started', 'r1'), () => {
      throw new Error('observer broke');
    });
    stamper.stamp(ev('step.completed', 'r1'), (e) => out.push(e.type));
    read.resolve('acme');
    await flush();
    expect(out).toEqual(['step.completed']);
  });

  it('bounds its cache', async () => {
    let reads = 0;
    const stamper = new RunAppStamper({
      namespaceOf: async () => {
        reads += 1;
        return 'acme';
      },
      cacheSize: 1,
    });
    const noop = () => {};
    stamper.stamp(ev('run.started', 'a', { namespace: 'acme' }), noop);
    stamper.stamp(ev('run.started', 'b', { namespace: 'acme' }), noop);
    stamper.stamp(ev('step.started', 'a'), noop);
    await flush();
    expect(reads).toBe(1);
  });
});
