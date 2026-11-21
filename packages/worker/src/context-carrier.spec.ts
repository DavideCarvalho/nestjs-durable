import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type DurableExecution,
  type RemoteTask,
  type WorkflowTask,
  clearDurableExecutionWrappers,
  useDurableExecution,
} from '@dudousxd/nestjs-durable-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    // The worker never sends a carrier back on its decision.
    expect(out.kind === 'decision' && 'context' in out.decision).toBe(false);
  });

  it('restores nothing without `rehydrate`, or for a task without a carrier', async () => {
    const seen: unknown[] = [];
    await runtimeSeeing(seen).handleTask(turn({ traceId: 'trace-1' }));
    await runtimeSeeing(seen, { rehydrate }).handleTask(turn());
    expect(seen).toEqual([null, null]);
  });

  it('runs a turn whose carrier `rehydrate` rejects without the carrier, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const seen: unknown[] = [];
      const rejecting = (() => {
        throw new Error('malformed carrier');
      }) as typeof rehydrate;
      const out = await runtimeSeeing(seen, { rehydrate: rejecting }).handleTask(
        turn({ traceId: 'bad' }),
      );
      expect(seen).toEqual([null]);
      expect(out.kind === 'decision' && out.decision.status).toBe('completed');
      expect(warn.mock.calls.flat().join(' ')).toMatch(/r1.*context carrier.*malformed carrier/);
    } finally {
      warn.mockRestore();
    }
  });

  it('fails a step whose carrier `rehydrate` rejects as retryable, without running its handler', async () => {
    const seen: unknown[] = [];
    const rejecting = (() => {
      throw new Error('malformed carrier');
    }) as typeof rehydrate;
    const out = await runtimeSeeing(seen, { rehydrate: rejecting }).handleTask(
      step({ traceId: 'bad' }),
    );
    expect(seen).toEqual([]);
    expect(out.kind === 'result' && out.result.status).toBe('failed');
    expect(out.kind === 'result' && out.result.error).toMatchObject({
      message: "could not restore the step's context carrier: malformed carrier",
      code: 'context_rehydrate_failed',
      retryable: true,
    });
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
