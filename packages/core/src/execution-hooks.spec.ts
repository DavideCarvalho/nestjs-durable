import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import {
  type DurableExecution,
  clearDurableExecutionWrappers,
  hasDurableExecutionWrappers,
  runDurableExecution,
  useDurableExecution,
} from './execution-hooks';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const turn: DurableExecution = {
  unit: 'workflow',
  runId: 'r1',
  workflow: 'w',
  name: undefined,
  seq: undefined,
  attempt: undefined,
};

describe('durable execution wrappers', () => {
  afterEach(() => clearDurableExecutionWrappers());

  it('returns the body promise untouched when nothing is registered', async () => {
    expect(hasDurableExecutionWrappers()).toBe(false);
    await expect(runDurableExecution(turn, async () => 'value')).resolves.toBe('value');
  });

  it('composes in onion order — first registered is outermost', async () => {
    const order: string[] = [];
    useDurableExecution(async (_e, next) => {
      order.push('A:before');
      const r = await next();
      order.push('A:after');
      return r;
    });
    useDurableExecution(async (_e, next) => {
      order.push('B:before');
      const r = await next();
      order.push('B:after');
      return r;
    });

    await runDurableExecution(turn, async () => {
      order.push('body');
      return 1;
    });

    expect(order).toEqual(['A:before', 'B:before', 'body', 'B:after', 'A:after']);
  });

  it('hands the wrapper the execution descriptor', async () => {
    const seen: DurableExecution[] = [];
    useDurableExecution(async (execution, next) => {
      seen.push(execution);
      return next();
    });

    await runDurableExecution(
      { unit: 'step', runId: 'r9', workflow: undefined, name: 'charge', seq: 3, attempt: 2 },
      async () => null,
    );

    expect(seen).toEqual([
      { unit: 'step', runId: 'r9', workflow: undefined, name: 'charge', seq: 3, attempt: 2 },
    ]);
  });

  it('settles with the BODY result even when a wrapper returns something else', async () => {
    useDurableExecution(async (_e, next) => {
      await next();
      return 'wrapper hijacked this';
    });

    await expect(runDurableExecution(turn, async () => 'real output')).resolves.toBe('real output');
  });

  it('still fails the unit when a wrapper swallows the body error', async () => {
    useDurableExecution(async (_e, next) => {
      try {
        return await next();
      } catch {
        return 'swallowed';
      }
    });

    await expect(
      runDurableExecution(turn, async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });

  it('still succeeds when a wrapper throws after the body completed', async () => {
    useDurableExecution(async (_e, next) => {
      const value = await next();
      void value;
      throw new Error('telemetry blew up');
    });

    await expect(runDurableExecution(turn, async () => 'fine')).resolves.toBe('fine');
  });

  it('surfaces a wrapper that fails BEFORE the body — nothing ran, nothing to return', async () => {
    useDurableExecution(async () => {
      throw new Error('could not open scope');
    });

    await expect(runDurableExecution(turn, async () => 'never')).rejects.toThrow(
      'could not open scope',
    );
  });

  it('reports a wrapper that never calls next() rather than inventing a result', async () => {
    useDurableExecution(async () => 'skipped the work');

    await expect(runDurableExecution(turn, async () => 'never')).rejects.toThrow(
      /without calling next/,
    );
  });

  it('unregisters cleanly', async () => {
    const dispose = useDurableExecution(async (_e, next) => next());
    expect(hasDurableExecutionWrappers()).toBe(true);
    dispose();
    expect(hasDurableExecutionWrappers()).toBe(false);
  });
});

describe('the engine drives the workflow-turn hook', () => {
  afterEach(() => clearDurableExecutionWrappers());

  it('wraps each turn of a real run, and the wrapper is ambient inside the body', async () => {
    const seen: DurableExecution[] = [];
    let insideBody = false;
    useDurableExecution(async (execution, next) => {
      seen.push(execution);
      const before = insideBody;
      insideBody = true;
      try {
        return await next();
      } finally {
        insideBody = before;
      }
    });

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    let sawWrapperFromBody = false;
    engine.register('greet', '1', async () => {
      sawWrapperFromBody = insideBody;
      return 'hi';
    });
    const res = await startRun(engine, 'greet', {}, 'run-1');

    expect(res.output).toBe('hi');
    expect(sawWrapperFromBody).toBe(true);
    expect(seen).toEqual([
      {
        unit: 'workflow',
        runId: 'run-1',
        workflow: 'greet',
        name: undefined,
        seq: undefined,
        attempt: undefined,
      },
    ]);
  });

  it('lets a failing workflow body fail exactly as it would unwrapped', async () => {
    useDurableExecution(async (_e, next) => next());

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    engine.register('boom', '1', async () => {
      throw new Error('nope');
    });
    const res = await startRun(engine, 'boom', {}, 'run-2');

    expect(res.status).toBe('failed');
    expect(res.error?.message).toBe('nope');
  });
});
