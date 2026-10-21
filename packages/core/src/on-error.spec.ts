import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { FatalError } from './errors';
import type { WorkerDescriptor } from './handshake/index';
import type {
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowTask,
} from './interfaces';
import { type OnErrorInput, assertRoutes, routeFor } from './on-error';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

async function until(check: () => boolean | Promise<boolean>, max = 2000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

function setup() {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const calls: Record<string, number> = {};
  const handle = (name: string, fn: (input: unknown) => Promise<unknown>) =>
    transport.handle(name, async (input: unknown) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return fn(input);
    });
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
  const settled = async (id: string) => {
    await until(async () => {
      const s = (await store.getRun(id))?.status;
      return s === 'completed' || s === 'failed';
    });
    return store.getRun(id);
  };
  return { store, transport, engine, calls, handle, settled };
}

const invalidLine = () => {
  throw new FatalError('line 3: amount is not a number', 'invalid_line');
};

describe('onError routes', () => {
  it('hands a matching failure to the handler workflow and completes with its output', async () => {
    const { engine, handle, settled, store } = setup();
    handle('validate', async () => invalidLine());
    const received: OnErrorInput[] = [];
    engine.register('line.invalid', '1', async (_ctx, input) => {
      received.push(input as OnErrorInput);
      return { failed: 1 };
    });
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'line', { n: 3 }, 'r');
    const run = await settled('r');

    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ failed: 1 });
    expect(received).toEqual([
      {
        runId: 'r',
        workflow: 'line',
        input: { n: 3 },
        error: expect.objectContaining({
          message: 'line 3: amount is not a number',
          code: 'invalid_line',
        }),
      },
    ]);
    expect((await store.getRun('r.onError'))?.status).toBe('completed');
    const handoff = (await store.listCheckpoints('r')).find((c) => c.name.endsWith('r.onError'));
    expect(handoff).toMatchObject({ kind: 'signal', status: 'completed' });
  });

  it('fails the run as usual when no route matches its code', async () => {
    const { engine, handle, settled, store } = setup();
    handle('validate', async () => {
      throw new FatalError('DPAS timed out', 'upstream');
    });
    engine.register('line.invalid', '1', async () => 'handled');
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'line', {}, 'r');
    const run = await settled('r');

    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toContain('DPAS timed out');
    expect(await store.getRun('r.onError')).toBeNull();
  });

  it('prefers the route for the exact code over the catch-all', async () => {
    const { engine, handle, settled } = setup();
    handle('validate', async () => invalidLine());
    engine.register('by-code', '1', async () => 'by code');
    engine.register('catch-all', '1', async () => 'catch-all');
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      onError: [{ workflow: 'catch-all' }, { code: 'invalid_line', workflow: 'by-code' }],
    });

    await startRun(engine, 'line', {}, 'r');
    expect((await settled('r'))?.output).toBe('by code');
  });

  it('routes a plain throw in the body to the catch-all', async () => {
    const { engine, settled } = setup();
    engine.register('catch-all', '1', async (_ctx, input) => ({
      caught: (input as OnErrorInput).error.message,
    }));
    engine.register(
      'line',
      '1',
      async () => {
        throw new Error('unexpected shape');
      },
      { onError: [{ workflow: 'catch-all' }] },
    );

    await startRun(engine, 'line', {}, 'r');
    expect((await settled('r'))?.output).toEqual({ caught: 'unexpected shape' });
  });

  it('fails the run with the handler error when the handler fails', async () => {
    const { engine, handle, settled } = setup();
    handle('validate', async () => invalidLine());
    engine.register('line.invalid', '1', async () => {
      throw new Error('dead-letter store is down');
    });
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'line', {}, 'r');
    const run = await settled('r');

    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toContain('dead-letter store is down');
  });

  it('does not re-dispatch the failed step when the run replays to take the outcome', async () => {
    const { engine, handle, settled, calls } = setup();
    handle('validate', async () => invalidLine());
    handle('deadLetter', async () => 'stored');
    engine.register('line.invalid', '1', async (ctx) => ctx.step('deadLetter', {}));
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}, { retries: 3 }), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'line', {}, 'r');
    expect((await settled('r'))?.output).toBe('stored');
    expect(calls.validate).toBe(1);
  });

  it('still runs the saga compensations of the failed body before handing off', async () => {
    const { engine, handle, settled } = setup();
    handle('validate', async () => invalidLine());
    const undone: string[] = [];
    engine.register('line.invalid', '1', async () => 'handled');
    engine.register(
      'line',
      '1',
      async (ctx) => {
        await ctx.localStep('reserve', async () => 'ok', {
          compensate: async () => {
            undone.push('reserve');
          },
        });
        return ctx.step('validate', {});
      },
      { onError: [{ code: 'invalid_line', workflow: 'line.invalid' }] },
    );

    await startRun(engine, 'line', {}, 'r');
    expect((await settled('r'))?.output).toBe('handled');
    expect(undone).toEqual(['reserve']);
  });

  it('takes the outcome off the handler run when its wake was lost', async () => {
    const { engine, handle, settled, store } = setup();
    handle('validate', async () => invalidLine());
    engine.register('line.invalid', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'handled late';
    });
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'line', {}, 'r');
    await until(async () => (await store.getRun('r.onError'))?.status === 'suspended');
    // Drop the failed run's waiter, as a crash between the handler settling and the wake would.
    await store.takeSignalWaiter('child:r.onError');
    await engine.signal('go', undefined);
    await settled('r.onError');
    expect((await store.getRun('r'))?.status).toBe('suspended');

    await engine.resume('r');
    const run = await settled('r');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('handled late');
  });

  it('never runs the body again once the failure is handed off, a resume included', async () => {
    const { engine, settled, store } = setup();
    let parses = 0;
    engine.register('line.invalid', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'handled';
    });
    engine.register(
      'line',
      '1',
      async (ctx) =>
        ctx.localStep('parse', async () => {
          parses += 1;
          // A second run would succeed and complete the run with the body's output.
          if (parses === 1) throw new Error('flaky parse');
          return 'parsed';
        }),
      { onError: [{ workflow: 'line.invalid' }] },
    );

    await startRun(engine, 'line', {}, 'r');
    await until(async () => (await store.getRun('r.onError'))?.status === 'suspended');
    // A reconcile wake or a manual resume while the handler still runs.
    await engine.resume('r');
    expect((await store.getRun('r'))?.status).toBe('suspended');

    await engine.signal('go', undefined);
    const run = await settled('r');
    expect(run?.output).toBe('handled');
    expect(parses).toBe(1);
  });

  it('keeps ctx.all over the workflow from failing the parent', async () => {
    const { engine, handle, settled } = setup();
    handle('validate', async (input) => {
      if ((input as { i: number }).i === 1) invalidLine();
      return { ok: 1, failed: 0 };
    });
    engine.register('line.invalid', '1', async () => ({ ok: 0, failed: 1 }));
    engine.register('line', '1', async (ctx, input) => ctx.step('validate', input), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });
    engine.register('file', '1', async (ctx) => ctx.all('line', [{ i: 0 }, { i: 1 }, { i: 2 }]));

    await startRun(engine, 'file', {}, 'f');
    const run = await settled('f');

    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual([
      { ok: 1, failed: 0 },
      { ok: 0, failed: 1 },
      { ok: 1, failed: 0 },
    ]);
  });

  it('routes the failure of a convention-served remote workflow by the routes its workers announce', async () => {
    const store = new InMemoryStateStore();
    const worker = new PythonLineWorker([{ code: 'invalid_line', workflow: 'line.invalid' }]);
    const engine = new WorkflowEngine({ store, transport: worker, reconcileMs: 0 });
    engine.register('line.invalid', '1', async (_ctx, input) => ({
      deadLettered: (input as OnErrorInput).error.code,
    }));

    await engine.start('py-line', { n: 1 }, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'completed');

    expect((await store.getRun('r'))?.output).toEqual({ deadLettered: 'invalid_line' });
    // One turn: once the failure is handed off, the body is never dispatched again.
    expect(worker.turns).toEqual([[]]);
  });

  it('does not route when the live workers announce different routes', async () => {
    const store = new InMemoryStateStore();
    const worker = new PythonLineWorker(
      [{ code: 'invalid_line', workflow: 'line.invalid' }],
      [{ code: 'invalid_line', workflow: 'line.invalid.v2' }],
    );
    const engine = new WorkflowEngine({ store, transport: worker, reconcileMs: 0 });
    engine.register('line.invalid', '1', async () => 'handled');

    await engine.start('py-line', {}, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'failed');

    expect(await store.getRun('r.onError')).toBeNull();
  });
});

/**
 * Stand-in for a Python worker serving `py-line` by convention: it announces the workflow (and its
 * onError routes) in its descriptor, and every turn records a failed `validate` step and fails.
 * A second route set makes it a fleet of two workers that disagree.
 */
class PythonLineWorker implements Transport {
  readonly turns: number[][] = [];
  private decide?: (decision: WorkflowDecision) => Promise<void>;
  constructor(
    private readonly routes: { code?: string; workflow: string }[],
    private readonly otherRoutes?: { code?: string; workflow: string }[],
  ) {}
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(): void {}
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decide = handler;
  }
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.turns.push(task.history.map((e) => e.seq));
    const error = { message: 'bad line', code: 'invalid_line', retryable: false };
    const commands = task.history.some((e) => e.seq === 0)
      ? []
      : [{ kind: 'recordStep' as const, seq: 0, name: 'validate', error }];
    setImmediate(() => {
      void this.decide?.({
        taskId: task.taskId,
        runId: task.runId,
        status: 'failed',
        commands,
        error,
      });
    });
  }
  async listWorkerGroups(): Promise<string[]> {
    return ['py-line'];
  }
  async readWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    const worker = (id: string, onError: { code?: string; workflow: string }[]) => ({
      instanceId: id,
      runtime: 'python' as const,
      sdk: { name: 'durable-worker', version: '0.30.0' },
      protocol: { version: 1, range: [1, 1] as [number, number] },
      capabilities: [],
      workflows: ['py-line'],
      steps: [],
      startedAt: 0,
      registrations: [{ name: 'py-line', group: 'py-line', onError }],
    });
    return [
      worker('py-1', this.routes),
      ...(this.otherRoutes ? [worker('py-2', this.otherRoutes)] : []),
    ];
  }
}

describe('routeFor', () => {
  it('never routes a broken deploy or a ctx misuse, even to a catch-all', () => {
    const routes = [{ workflow: 'catch-all' }];
    expect(routeFor(routes, { message: 'x', code: 'non_determinism' })).toBeUndefined();
    expect(routeFor(routes, { message: 'x', code: 'nested_workflow_call' })).toBeUndefined();
    expect(routeFor(routes, { message: 'x' })).toEqual({ workflow: 'catch-all' });
  });
});

describe('assertRoutes', () => {
  it('rejects two routes for one code, or two catch-alls', () => {
    expect(() =>
      assertRoutes('line', [
        { code: 'a', workflow: 'x' },
        { code: 'a', workflow: 'y' },
      ]),
    ).toThrow('code "a"');
    expect(() => assertRoutes('line', [{ workflow: 'x' }, { workflow: 'y' }])).toThrow(
      'without a code',
    );
  });
});
