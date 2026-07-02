import { describe, expect, it } from 'vitest';
import { DURABLE_STEP_CONFIG, DURABLE_STEP_NAME, type StepConfig } from './step-name-symbol';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import type { CtxHost } from './workflow-ctx';
import { createWorkflowCtx } from './workflow-ctx';

const PING_STEP_NAME = 'ext.ping';

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

describe('WorkflowCtx.step (dispatched)', () => {
  it('ctx.step(name, input) dispatches exactly one call through host.callRemote', async () => {
    const dispatched: RecordedDispatch[] = [];
    const ctx = createWorkflowCtx(fakeHost(dispatched), 'run-1', []);

    const output = await ctx.step<{ pong: boolean }>(PING_STEP_NAME, {});

    expect(output).toEqual({ pong: true });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      runId: 'run-1',
      seq: 0,
      step: { name: PING_STEP_NAME },
      input: {},
    });
  });

  it('carries a @Step-stamped dispatch policy onto the StepDef, per-call opts winning field-by-field', async () => {
    function chargeCard() {}
    const config: StepConfig = { retries: 3, backoff: 'fixed', backoffMs: 100, timeoutMs: 5000 };
    (chargeCard as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = 'Payments.chargeCard';
    (chargeCard as { [DURABLE_STEP_CONFIG]?: StepConfig })[DURABLE_STEP_CONFIG] = config;

    const dispatched: RecordedDispatch[] = [];
    const ctx = createWorkflowCtx(fakeHost(dispatched), 'run-1', []);

    // No opts: the @Step-declared policy passes through untouched.
    await ctx.step(chargeCard, {});
    expect(dispatched[0]?.step).toMatchObject({
      name: 'Payments.chargeCard',
      retries: 3,
      backoff: 'fixed',
      backoffMs: 100,
      timeoutMs: 5000,
    });

    // A per-call opts field overrides the declared policy for that field only.
    await ctx.step(chargeCard, {}, { retries: 5, timeoutMs: 1000 });
    expect(dispatched[1]?.step).toMatchObject({
      name: 'Payments.chargeCard',
      retries: 5, // overridden
      backoff: 'fixed', // untouched, from @Step
      backoffMs: 100, // untouched, from @Step
      timeoutMs: 1000, // overridden
    });
  });

  it('a plain string call has no stamped config, so it uses opts only', async () => {
    const dispatched: RecordedDispatch[] = [];
    const ctx = createWorkflowCtx(fakeHost(dispatched), 'run-1', []);

    await ctx.step(PING_STEP_NAME, {}, { retries: 2, timeoutMs: 250 });

    expect(dispatched[0]?.step).toMatchObject({
      name: PING_STEP_NAME,
      retries: 2,
      timeoutMs: 250,
    });
    expect(dispatched[0]?.step).not.toHaveProperty('backoff');
    expect(dispatched[0]?.step).not.toHaveProperty('backoffMs');
  });
});
