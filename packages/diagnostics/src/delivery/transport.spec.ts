import 'reflect-metadata';
import { emit } from '@dudousxd/nestjs-diagnostics';
import {
  type DeliveredEvent,
  type DeliveryTransportContext,
  DiagnosticsModule,
  OnDiagnostic,
  transports,
} from '@dudousxd/nestjs-diagnostics/nestjs';
import { DurableModule } from '@dudousxd/nestjs-durable';
import {
  type EngineEvent,
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachDurableDiagnostics } from '../attach-durable-diagnostics';
import {
  DIAGNOSTICS_LISTENER_ORIGIN,
  DIAGNOSTICS_LISTENER_WORKFLOW,
  createDeliveryTransport,
  diagnosticsRunId,
  isConfigured,
  isDiagnosticsDeliveryEvent,
} from './index';
import { diagnosticsStepOptions } from './transport';

const calls: Array<{ listener: string; id: string; payload: unknown }> = [];
let failuresLeft = 0;

@Injectable()
class OrderListeners {
  @OnDiagnostic('orders', 'placed')
  async onPlaced(event: DeliveredEvent) {
    calls.push({ listener: 'onPlaced', id: event.id, payload: event.payload });
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error('listener failed');
    }
  }
}

const LISTENER_ID = 'OrderListeners#onPlaced';

async function bootApp(
  store: InMemoryStateStore,
  role: 'all' | 'api' | 'worker' = 'all',
): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 20 }),
      DiagnosticsModule.forRoot({
        default: 'durable',
        role,
        transports: {
          durable: transports.durable({ retries: 3, backoff: 'fixed', backoffMs: 0 }),
        },
      }),
    ],
    providers: [OrderListeners],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

async function settledRun(store: InMemoryStateStore): Promise<WorkflowRun> {
  return waitFor(async () => {
    const [run] = await store.listRuns({ workflow: DIAGNOSTICS_LISTENER_WORKFLOW });
    return run && (run.status === 'completed' || run.status === 'failed') ? run : undefined;
  });
}

describe('transports.durable() delivery', () => {
  let app: TestingModule | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    calls.length = 0;
    failuresLeft = 0;
  });

  it('runs each listener once, as a run with the delivery id', async () => {
    const store = new InMemoryStateStore();
    app = await bootApp(store);

    emit('orders', 'placed', { orderId: 1 });
    const run = await settledRun(store);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.payload).toEqual({ orderId: 1 });
    expect(run.id).toBe(diagnosticsRunId(call?.id ?? '', LISTENER_ID));
    expect(run.status).toBe('completed');
    expect(run.origin).toBe(DIAGNOSTICS_LISTENER_ORIGIN);
    expect(run.tags).toEqual(
      expect.arrayContaining([
        'diagnostics',
        'lib:orders',
        'event:placed',
        `listener:${LISTENER_ID}`,
      ]),
    );
  });

  it('retries a listener that throws, inside one step', async () => {
    const store = new InMemoryStateStore();
    app = await bootApp(store);
    failuresLeft = 2;

    emit('orders', 'placed', { orderId: 2 });
    const run = await settledRun(store);

    expect(run.status).toBe('completed');
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.id)).size).toBe(1);
    const checkpoints = await store.listCheckpoints(run.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ name: 'handle', status: 'completed', attempts: 3 });
  });

  it('fails the run once the retries are spent', async () => {
    const store = new InMemoryStateStore();
    app = await bootApp(store);
    failuresLeft = 10;

    emit('orders', 'placed', { orderId: 3 });
    const run = await settledRun(store);

    expect(run.status).toBe('failed');
    expect(calls).toHaveLength(3);
  });

  it("never runs a listener on role 'api': the run is stored and waits for a worker", async () => {
    const store = new InMemoryStateStore();
    app = await bootApp(store, 'api');

    emit('orders', 'placed', { orderId: 4 });
    const run = await waitFor(async () => {
      const [r] = await store.listRuns({ workflow: DIAGNOSTICS_LISTENER_WORKFLOW });
      return r;
    });
    // Several timer polls of this (driving) engine go by.
    await new Promise((r) => setTimeout(r, 150));

    expect(calls).toHaveLength(0);
    expect((await store.getRun(run.id))?.status).toBe('pending');

    // A worker on the same store runs it.
    const worker = new WorkflowEngine({ store, instanceId: 'worker' });
    const invoke = vi.fn(async () => undefined);
    createDeliveryTransport(context(worker, 'worker', invoke));
    await worker.runPending();
    await worker.waitForRun(run.id);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(LISTENER_ID, expect.objectContaining({ lib: 'orders' }));
  });
});

function moduleRefOf(engine: unknown): ModuleRef {
  return {
    get: () => {
      if (engine === undefined) throw new Error('not found');
      return engine;
    },
  } as unknown as ModuleRef;
}

function context(
  engine: unknown,
  role: DeliveryTransportContext['role'],
  invoke: DeliveryTransportContext['invoke'] = async () => undefined,
): DeliveryTransportContext {
  return { moduleRef: moduleRefOf(engine), nodeId: 'n1', role, invoke, listenerIds: [] };
}

function envelope(id: string): DeliveredEvent {
  return { id, lib: 'orders', event: 'placed', payload: {}, ts: 0 } as unknown as DeliveredEvent;
}

describe('createDeliveryTransport', () => {
  it('starts one run per delivery and treats a repeat as delivered', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const invoke = vi.fn(async () => undefined);
    const transport = createDeliveryTransport(context(engine, 'all', invoke));

    const deliveries = [
      { listenerId: 'A#a', envelope: envelope('e1') },
      { listenerId: 'B#b', envelope: envelope('e1') },
    ];
    await transport.deliver(deliveries);
    await transport.deliver(deliveries);
    await engine.waitForRun(diagnosticsRunId('e1', 'A#a'));
    await engine.waitForRun(diagnosticsRunId('e1', 'B#b'));

    expect((await store.listRuns({})).map((r) => r.id).sort()).toEqual([
      'diag:e1:A#a',
      'diag:e1:B#b',
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('fails an unknown listener at once, without retrying', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const unknown = Object.assign(new Error('no listener Gone#x'), {
      code: 'E_UNKNOWN_DIAGNOSTICS_LISTENER',
    });
    const invoke = vi.fn(async () => {
      throw unknown;
    });
    const transport = createDeliveryTransport(context(engine, 'all', invoke), {
      retries: 5,
      backoffMs: 0,
    });

    await transport.deliver([{ listenerId: 'Gone#x', envelope: envelope('e2') }]);
    const result = await engine.waitForRun(diagnosticsRunId('e2', 'Gone#x'));

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'E_UNKNOWN_DIAGNOSTICS_LISTENER' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects deliveries after stop()', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const transport = createDeliveryTransport(context(engine, 'all'));
    await transport.stop();
    await expect(
      transport.deliver([{ listenerId: 'A#a', envelope: envelope('e3') }]),
    ).rejects.toThrow(/stopped/);
  });

  it('on a thin client: starts runs on api, refuses to run them elsewhere', async () => {
    const start = vi.fn(async () => ({ runId: 'x', status: 'pending' }));
    const thin = { start };

    const api = createDeliveryTransport(context(thin, 'api'));
    await api.deliver([{ listenerId: 'A#a', envelope: envelope('e4') }]);
    expect(start).toHaveBeenCalledWith(
      DIAGNOSTICS_LISTENER_WORKFLOW,
      { listenerId: 'A#a', envelope: envelope('e4') },
      'diag:e4:A#a',
      expect.objectContaining({ tags: expect.arrayContaining(['listener:A#a']) }),
    );

    expect(() => createDeliveryTransport(context(thin, 'worker'))).toThrow(/thin client/);
  });

  it('isConfigured is false without a durable engine', () => {
    expect(isConfigured(moduleRefOf(undefined))).toBe(false);
    expect(isConfigured(moduleRefOf(new WorkflowEngine({ store: new InMemoryStateStore() })))).toBe(
      true,
    );
  });
});

describe('diagnosticsStepOptions', () => {
  it('defaults to three attempts with exponential backoff', () => {
    expect(diagnosticsStepOptions()).toEqual({
      retries: 3,
      backoff: 'exp',
      backoffMs: 1_000,
      backoffMaxMs: 30_000,
    });
  });

  it('takes the transport options over the defaults', () => {
    expect(
      diagnosticsStepOptions({
        retries: 5,
        backoff: 'fixed',
        backoffMs: 10,
        backoffMaxMs: 20,
        jitter: true,
      }),
    ).toEqual({ retries: 5, backoff: 'fixed', backoffMs: 10, backoffMaxMs: 20, jitter: true });
  });

  it.each([
    [{ retries: 0 }, /retries/],
    [{ retries: 1.5 }, /retries/],
    [{ backoffMs: -1 }, /backoffMs/],
    [{ backoffMaxMs: Number.NaN }, /backoffMaxMs/],
    [{ backoff: 'linear' as 'fixed' }, /backoff/],
  ])('refuses %j', (config, message) => {
    expect(() => diagnosticsStepOptions(config)).toThrow(message);
  });
});

describe('the bus bridge and delivery runs', () => {
  it('recognises a delivery run by workflow or run id', () => {
    expect(isDiagnosticsDeliveryEvent({ workflow: DIAGNOSTICS_LISTENER_WORKFLOW })).toBe(true);
    expect(isDiagnosticsDeliveryEvent({ runId: 'diag:e:A#a' })).toBe(true);
    expect(isDiagnosticsDeliveryEvent({ workflow: 'orders', runId: 'diag:x' })).toBe(false);
    expect(isDiagnosticsDeliveryEvent({ runId: 'r1' })).toBe(false);
  });

  it('does not forward the lifecycle events of delivery runs', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('orders', '1', async () => 'ok');
    const transport = createDeliveryTransport(context(engine, 'all'));
    const forwarded: EngineEvent[] = [];
    const { getChannel } = await import('@dudousxd/nestjs-diagnostics');
    const onMessage = (msg: unknown) => forwarded.push((msg as { payload: EngineEvent }).payload);
    const channel = getChannel('durable', 'run.completed');
    channel.subscribe(onMessage);
    const off = attachDurableDiagnostics(engine);
    try {
      await transport.deliver([{ listenerId: 'A#a', envelope: envelope('e5') }]);
      await engine.waitForRun('diag:e5:A#a');
      await engine.start('orders', {}, 'o1');
      await engine.waitForRun('o1');
      expect(forwarded.map((e) => e.runId)).toEqual(['o1']);
    } finally {
      off();
      channel.unsubscribe(onMessage);
    }
  });
});
