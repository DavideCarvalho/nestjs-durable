import type { RemoteTask, WorkflowTask } from '@dudousxd/nestjs-durable-core';
import {
  type DurableExecution,
  clearDurableExecutionWrappers,
  useDurableExecution,
} from '@dudousxd/nestjs-durable-core';
import { afterEach, describe, expect, it } from 'vitest';
import { StepWorker } from './step-worker';
import { WorkflowWorker } from './workflow-worker';

/**
 * The worker package carries its own copies of the step/turn runners (a thin or co-located worker
 * has no engine and no transport-level `runStepHandler` call), so the execution hooks have to be
 * folded in there too. These assert the hook fires on THAT path — the one a BullMQ deployment
 * actually runs — rather than on the in-process transport path the e2e exercises.
 */

const stepTask: RemoteTask = {
  runId: 'r1',
  seq: 2,
  name: 'payments.charge',
  stepId: 'r1:2',
  group: 'steps',
  input: { amount: 1 },
  attempt: 3,
};

describe('worker execution hooks', () => {
  afterEach(() => clearDurableExecutionWrappers());

  it('wraps a step handler body, and the scope is ambient while it runs', async () => {
    const seen: DurableExecution[] = [];
    let inScope = false;
    useDurableExecution(async (execution, next) => {
      seen.push(execution);
      inScope = true;
      try {
        return await next();
      } finally {
        inScope = false;
      }
    });

    let sawScope = false;
    const worker = new StepWorker().register('payments.charge', async () => {
      sawScope = inScope;
      return { charged: true };
    });
    const result = await worker.processTask(stepTask);

    expect(result.status).toBe('completed');
    expect(sawScope).toBe(true);
    expect(seen).toEqual([
      {
        unit: 'step',
        runId: 'r1',
        workflow: undefined,
        name: 'payments.charge',
        seq: 2,
        attempt: 3,
      },
    ]);
  });

  it('keeps a throwing handler a failed result — the wrapper changes nothing', async () => {
    useDurableExecution(async (_e, next) => next());
    const worker = new StepWorker().register('payments.charge', async () => {
      throw new Error('declined');
    });

    const result = await worker.processTask(stepTask);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('declined');
  });

  it('wraps a workflow turn replay', async () => {
    const seen: DurableExecution[] = [];
    useDurableExecution(async (execution, next) => {
      seen.push(execution);
      return next();
    });

    const task: WorkflowTask = {
      taskId: 't1',
      runId: 'r2',
      workflow: 'checkout',
      input: {},
      history: [],
    };
    const worker = new WorkflowWorker().register('checkout', async () => 'ok');
    const decision = await worker.processTask(task);

    expect(decision.status).toBe('completed');
    expect(seen).toEqual([
      {
        unit: 'workflow',
        runId: 'r2',
        workflow: 'checkout',
        name: undefined,
        seq: undefined,
        attempt: undefined,
      },
    ]);
  });

  it('does not wrap an unknown name — nothing executed, so there is no unit of work', async () => {
    const seen: DurableExecution[] = [];
    useDurableExecution(async (execution, next) => {
      seen.push(execution);
      return next();
    });

    const result = await new StepWorker().processTask(stepTask);
    expect(result.status).toBe('failed');
    expect(seen).toEqual([]);
  });
});
