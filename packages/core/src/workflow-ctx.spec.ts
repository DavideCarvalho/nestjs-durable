import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { remoteStep } from './remote-step-factory';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import type { CtxHost } from './workflow-ctx';
import { createWorkflowCtx } from './workflow-ctx';

const ping = remoteStep({
  name: 'ext.ping',
  group: 'ext',
  input: z.object({}),
  output: z.object({ pong: z.boolean() }),
});

/** A recorded `host.callRemote` invocation, captured by {@link fakeHost}. */
interface RecordedDispatch {
  runId: string;
  seq: number;
  step: unknown;
  input: unknown;
}

/** A minimal {@link CtxHost} whose `callRemote` records every dispatch and resolves `{ pong: true }`. */
function fakeHost(dispatched: RecordedDispatch[]): CtxHost {
  return {
    store: new InMemoryStateStore(),
    clock: () => Date.now(),
    startStep: async () => {},
    completeStep: async () => {},
    failStep: async () => {},
    async callRemote<TInput, TOutput>(
      runId: string,
      seq: number,
      step: unknown,
      input: TInput,
    ): Promise<TOutput> {
      dispatched.push({ runId, seq, step, input });
      return { pong: true } as TOutput;
    },
    startChild: () => {},
    upsertSearchAttributes: async () => {},
  };
}

describe('WorkflowCtx.remote / ctx.call alias', () => {
  it('ctx.remote dispatches exactly one call through host.callRemote', async () => {
    const dispatched: RecordedDispatch[] = [];
    const ctx = createWorkflowCtx(fakeHost(dispatched), 'run-1', []);

    const output = await ctx.remote(ping, {});

    expect(output).toEqual({ pong: true });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ runId: 'run-1', seq: 0, step: ping, input: {} });
  });

  it('ctx.call is an identical back-compat alias for ctx.remote', async () => {
    const dispatched: RecordedDispatch[] = [];
    const ctx = createWorkflowCtx(fakeHost(dispatched), 'run-1', []);

    const output = await ctx.call(ping, {});

    expect(output).toEqual({ pong: true });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ runId: 'run-1', seq: 0, step: ping, input: {} });
  });
});
