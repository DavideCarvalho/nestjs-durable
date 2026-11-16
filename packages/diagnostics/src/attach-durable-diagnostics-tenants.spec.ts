import 'reflect-metadata';
import { DurableModule } from '@dudousxd/nestjs-durable';
import {
  type EngineEvent,
  type EngineListener,
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
  runTraceId,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real `emit`, wrapped so each call's options (`traceId`, `app`) are visible: the installed
// diagnostics version may predate the envelope `app`, which the bridge passes regardless.
const { emitSpy } = vi.hoisted(() => ({ emitSpy: vi.fn() }));
vi.mock('@dudousxd/nestjs-diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dudousxd/nestjs-diagnostics')>();
  emitSpy.mockImplementation(actual.emit as (...args: unknown[]) => void);
  return { ...actual, emit: emitSpy };
});

import { attachDurableDiagnostics } from './attach-durable-diagnostics';
import { DurableDiagnosticsModule } from './durable-diagnostics.module';

type Emitted = { event: string; payload: EngineEvent & { app?: string }; opts?: unknown };
const emitted = (): Emitted[] =>
  emitSpy.mock.calls.map(([, event, payload, opts]) => ({
    event: event as string,
    payload: payload as Emitted['payload'],
    opts,
  }));

/** A controllable engine event source plus a run → namespace map behind `getRun`. */
function fakeEngine(namespaces: Record<string, string | undefined>) {
  const listeners: EngineListener[] = [];
  const engine = {
    subscribe(listener: EngineListener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  } as unknown as WorkflowEngine;
  const fire = (event: Partial<EngineEvent> & Pick<EngineEvent, 'type' | 'runId'>) => {
    for (const l of listeners) l({ at: new Date(0), ...event } as EngineEvent);
  };
  const reads: string[] = [];
  const namespaceOf = async (runId: string) => {
    reads.push(runId);
    return namespaces[runId];
  };
  return { engine, fire, reads, namespaceOf };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('attachDurableDiagnostics with tenant attribution (control plane)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    emitSpy.mockClear();
  });

  it("stamps app on every event of a tenant's run, in the run trace, step events included", async () => {
    const { engine, fire, reads, namespaceOf } = fakeEngine({ r1: 'acme' });
    cleanups.push(attachDurableDiagnostics(engine, { tenants: { namespaceOf } }));

    fire({ type: 'run.started', runId: 'r1', workflow: 'wf', namespace: 'acme' });
    fire({ type: 'step.started', runId: 'r1', seq: 1, name: 'charge' });
    fire({ type: 'step.completed', runId: 'r1', seq: 1, name: 'charge' });
    fire({ type: 'run.completed', runId: 'r1', workflow: 'wf', namespace: 'acme' });
    await flush();

    const out = emitted();
    expect(out.map((e) => e.event)).toEqual([
      'run.started',
      'step.started',
      'step.completed',
      'run.completed',
    ]);
    for (const e of out) {
      expect(e.payload.app).toBe('acme');
      expect(e.payload.namespace).toBe('acme');
      expect(e.opts).toEqual({ traceId: runTraceId('r1'), app: 'acme' });
    }
    // The run event carried the partition; the step events reused it.
    expect(reads).toEqual([]);
  });

  it('reads an unseen run once and keeps emission order behind the read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { engine, fire, reads } = fakeEngine({});
    const namespaceOf = async (runId: string) => {
      reads.push(runId);
      await gate;
      return 'acme';
    };
    cleanups.push(attachDurableDiagnostics(engine, { tenants: { namespaceOf } }));

    fire({ type: 'step.started', runId: 'resumed', seq: 3, name: 's' });
    fire({ type: 'step.completed', runId: 'resumed', seq: 3, name: 's' });
    fire({ type: 'run.started', runId: 'other', namespace: 'beta' });
    await flush();
    // Another run's event is not held behind this run's read.
    expect(emitted().map((e) => `${e.payload.runId}:${e.event}`)).toEqual(['other:run.started']);

    release();
    await flush();
    expect(emitted().map((e) => `${e.payload.runId}:${e.event}:${e.payload.app}`)).toEqual([
      'other:run.started:beta',
      'resumed:step.started:acme',
      'resumed:step.completed:acme',
    ]);
    expect(reads).toEqual(['resumed']);
  });

  it("leaves the control plane's own runs untouched", async () => {
    const { engine, fire, namespaceOf } = fakeEngine({ own: 'ops', bare: undefined });
    cleanups.push(attachDurableDiagnostics(engine, { tenants: { namespaceOf, own: ['ops'] } }));

    fire({ type: 'run.started', runId: 'own', namespace: 'ops' });
    fire({ type: 'step.started', runId: 'own', seq: 1 });
    fire({ type: 'run.started', runId: 'dflt', namespace: 'default' });
    fire({ type: 'step.started', runId: 'bare', seq: 1 });
    await flush();

    const out = emitted();
    expect(out).toHaveLength(4);
    for (const e of out) {
      expect('app' in e.payload).toBe(false);
      expect(e.opts).toBeUndefined();
    }
  });

  it('forwards unattributed when the read fails, and reads again on the next event', async () => {
    let calls = 0;
    const { engine, fire } = fakeEngine({});
    const namespaceOf = async () => {
      calls += 1;
      if (calls === 1) throw new Error('store down');
      return 'acme';
    };
    cleanups.push(attachDurableDiagnostics(engine, { tenants: { namespaceOf } }));

    fire({ type: 'step.started', runId: 'r', seq: 1 });
    await flush();
    fire({ type: 'step.completed', runId: 'r', seq: 1 });
    await flush();

    expect(emitted().map((e) => e.payload.app)).toEqual([undefined, 'acme']);
  });

  it('standalone (no tenants): events go out exactly as the engine produced them', async () => {
    const { engine, fire } = fakeEngine({});
    cleanups.push(attachDurableDiagnostics(engine));

    fire({ type: 'run.started', runId: 'r', namespace: 'acme' });
    fire({ type: 'step.started', runId: 'r', seq: 1 });

    const out = emitted();
    expect(out).toHaveLength(2);
    for (const e of out) {
      expect('app' in e.payload).toBe(false);
      expect(e.opts).toBeUndefined();
    }
  });
});

describe('DurableDiagnosticsModule per topology', () => {
  afterEach(() => emitSpy.mockClear());

  async function boot(options: Parameters<typeof DurableModule.forRoot>[0]) {
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot(options), DurableDiagnosticsModule.forRoot()],
    }).compile();
    await moduleRef.init();
    return moduleRef;
  }

  it("control plane: a tenant's run is attributed end to end, its own runs are not", async () => {
    const moduleRef = await boot({
      topology: 'control-plane',
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    try {
      const engine = moduleRef.get(WorkflowEngine, { strict: false });
      engine.register('checkout', '1', async (ctx) => {
        await ctx.localStep('charge', async () => 1);
        return 'ok';
      });
      await engine.start('checkout', {}, 'tenant-run', { namespace: 'acme' });
      await engine.waitForRun('tenant-run');
      await engine.start('checkout', {}, 'own-run');
      await engine.waitForRun('own-run');
      await flush();

      const tenant = emitted().filter((e) => e.payload.runId === 'tenant-run');
      expect(tenant.map((e) => e.event)).toEqual(
        expect.arrayContaining(['run.started', 'step.completed', 'run.completed']),
      );
      for (const e of tenant) {
        expect(e.payload.app).toBe('acme');
        expect(e.opts).toEqual({ traceId: runTraceId('tenant-run'), app: 'acme' });
      }
      const own = emitted().filter((e) => e.payload.runId === 'own-run');
      expect(own.length).toBeGreaterThan(0);
      for (const e of own) expect('app' in e.payload).toBe(false);
    } finally {
      await moduleRef.close();
    }
  });

  it('standalone: unchanged, a namespaced run gets no app', async () => {
    const moduleRef = await boot({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    try {
      const engine = moduleRef.get(WorkflowEngine, { strict: false });
      engine.register('checkout', '1', async () => 'ok');
      await engine.start('checkout', {}, 'r', { namespace: 'acme' });
      await engine.waitForRun('r');
      await flush();
      const out = emitted();
      expect(out.length).toBeGreaterThan(0);
      for (const e of out) {
        expect('app' in e.payload).toBe(false);
        expect(e.opts).toBeUndefined();
      }
    } finally {
      await moduleRef.close();
    }
  });

  it('tenant pod: boots without a local event stream and emits nothing', async () => {
    const moduleRef = await boot({
      topology: 'tenant',
      partition: 'acme',
      connection: 'redis://127.0.0.1:1',
    } as Parameters<typeof DurableModule.forRoot>[0]);
    try {
      expect(emitted()).toEqual([]);
    } finally {
      await moduleRef.close();
    }
  });
});
