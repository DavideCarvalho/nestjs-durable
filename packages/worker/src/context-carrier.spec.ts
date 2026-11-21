import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type DurableExecution,
  type RemoteTask,
  type WorkflowTask,
  clearDurableExecutionWrappers,
  useDurableExecution,
} from '@dudousxd/nestjs-durable-core';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableWorkerRuntime } from './runner-core';

const als = new AsyncLocalStorage<Record<string, unknown>>();
const rehydrate = <T>(carrier: Record<string, unknown> | undefined, fn: () => T): T =>
  carrier ? als.run(carrier, fn) : fn();

const turn = (context?: Record<string, unknown>): WorkflowTask => ({
  taskId: 'r1:wf:1',
  runId: 'r1',
  workflow: 'ask',
  workflowVersion: '1',
  input: null,
  history: [],
  group: 'ask',
  attempt: 1,
  ...(context ? { context } : {}),
});

const step = (context?: Record<string, unknown>): RemoteTask => ({
  runId: 'r1',
  seq: 0,
  name: 'probe',
  stepId: 'r1:0',
  group: 'probe',
  input: null,
  attempt: 1,
  ...(context ? { context } : {}),
});

function runtimeSeeing(seen: unknown[], options: { rehydrate?: typeof rehydrate } = {}) {
  return new DurableWorkerRuntime(options)
    .registerWorkflow('ask', async (ctx) => {
      await ctx.sideEffect(() => {
        seen.push(als.getStore() ?? null);
        return null;
      });
      return 'done';
    })
    .registerStep('probe', () => {
      seen.push(als.getStore() ?? null);
      return 'ok';
    });
}

afterEach(() => clearDurableExecutionWrappers());

describe('DurableWorkerRuntime — the dispatched context carrier', () => {
  it('restores the carrier around a dispatched turn and a dispatched step through `rehydrate`', async () => {
    const seen: unknown[] = [];
    const runtime = runtimeSeeing(seen, { rehydrate });
    const carrier = { traceId: 'trace-1' };
    const out = await runtime.handleTask(turn(carrier));
    await runtime.handleTask(step(carrier));
    expect(seen).toEqual([carrier, carrier]);
    expect(out.kind === 'decision' && out.decision.context).toEqual(carrier);
  });

  it('restores nothing without `rehydrate`, and a task without a carrier echoes none', async () => {
    const seen: unknown[] = [];
    await runtimeSeeing(seen).handleTask(turn({ traceId: 'trace-1' }));
    const out = await runtimeSeeing(seen, { rehydrate }).handleTask(turn());
    expect(seen).toEqual([null, null]);
    expect(out.kind === 'decision' && 'context' in out.decision).toBe(false);
  });

  it('hands the carrier to the execution wrappers, which run inside it', async () => {
    const wrapped: Array<{ unit: string; context: unknown; ambient: unknown }> = [];
    useDurableExecution(async (execution: DurableExecution, next) => {
      wrapped.push({
        unit: execution.unit,
        context: execution.context,
        ambient: als.getStore() ?? null,
      });
      return next();
    });
    const runtime = runtimeSeeing([], { rehydrate });
    const carrier = { traceId: 'trace-2' };
    await runtime.handleTask(turn(carrier));
    await runtime.handleTask(step(carrier));
    expect(wrapped).toEqual([
      { unit: 'workflow', context: carrier, ambient: carrier },
      { unit: 'step', context: carrier, ambient: carrier },
    ]);
  });
});
