import type { RemoteTask, WorkflowTask } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFIX,
  DurableWorkerRuntime,
  controlChannel,
  decisionsName,
  isWorkflowTask,
  resultsName,
  stepEventsName,
  tasksName,
  workerHeartbeatKey,
} from './runner-core';

function workflowTask(over: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    taskId: 't0',
    runId: 'r1',
    workflow: 'wf',
    workflowVersion: '1',
    input: null,
    history: [],
    pendingSignals: [],
    group: 'wf',
    attempt: 1,
    ...over,
  };
}

function remoteTask(over: Partial<RemoteTask> = {}): RemoteTask {
  return {
    runId: 'r1',
    seq: 0,
    name: 'charge',
    stepId: 'r1:0',
    group: 'steps',
    input: { amount: 5 },
    attempt: 1,
    ...over,
  };
}

describe('queue-name helpers match BullMQTransport conventions', () => {
  // These literals are the transport's documented conventions (packages/transport-bullmq):
  //   tasksName(group)  -> `${prefix}-tasks-${group}`
  //   resultsName()     -> `${prefix}-results`
  //   decisionsName()   -> `${prefix}-decisions`
  //   stepEventsName()  -> `${prefix}-step-events`
  //   controlChannel()  -> `${prefix}-control`
  //   workerHeartbeatKey(group, id) -> `${prefix}-worker-heartbeat:${group}:${id}`
  // A drift here means the Node worker silently consumes/publishes on the wrong queue.
  it('uses the default prefix the transport defaults to', () => {
    expect(DEFAULT_PREFIX).toBe('durable');
  });

  it('matches the exact tasks/results/decisions/step-events/control names', () => {
    expect(tasksName('durable', 'pipeline')).toBe('durable-tasks-pipeline');
    expect(resultsName('durable')).toBe('durable-results');
    expect(decisionsName('durable')).toBe('durable-decisions');
    expect(stepEventsName('durable')).toBe('durable-step-events');
    expect(controlChannel('durable')).toBe('durable-control');
    expect(workerHeartbeatKey('durable', 'pipeline', 'ts-host-1')).toBe(
      'durable-worker-heartbeat:pipeline:ts-host-1',
    );
  });

  it('honours a custom prefix consistently across every name', () => {
    expect(tasksName('app', 'g')).toBe('app-tasks-g');
    expect(resultsName('app')).toBe('app-results');
    expect(decisionsName('app')).toBe('app-decisions');
    expect(stepEventsName('app')).toBe('app-step-events');
    expect(controlChannel('app')).toBe('app-control');
    expect(workerHeartbeatKey('app', 'g', 'i')).toBe('app-worker-heartbeat:g:i');
  });
});

describe('isWorkflowTask discriminator', () => {
  it('routes a WorkflowTask (has workflow + history) as a workflow', () => {
    expect(isWorkflowTask(workflowTask())).toBe(true);
  });

  it('routes a RemoteTask (has stepId/name, no workflow/history) as a step', () => {
    expect(isWorkflowTask(remoteTask())).toBe(false);
  });

  it('is not fooled by a RemoteTask carrying optional extras', () => {
    expect(isWorkflowTask(remoteTask({ traceparent: '00-x', priority: 9, transport: 't' }))).toBe(
      false,
    );
  });
});

describe('DurableWorkerRuntime.handleTask routing', () => {
  it('routes a workflow task to the WorkflowWorker and returns a decision', async () => {
    const rt = new DurableWorkerRuntime();
    rt.registerWorkflow('wf', async () => ({ ok: true }));
    const out = await rt.handleTask(workflowTask());
    expect(out.kind).toBe('decision');
    if (out.kind === 'decision') {
      expect(out.decision.status).toBe('completed');
      expect(out.decision.output).toEqual({ ok: true });
      expect(out.decision.runId).toBe('r1');
    }
  });

  it('routes a step task to the StepWorker and returns a result', async () => {
    const rt = new DurableWorkerRuntime();
    rt.registerStep<{ amount: number }, number>('charge', (input) => input.amount * 2);
    const out = await rt.handleTask(remoteTask());
    expect(out.kind).toBe('result');
    if (out.kind === 'result') {
      expect(out.result.status).toBe('completed');
      expect(out.result.output).toBe(10);
      expect(out.result.stepId).toBe('r1:0');
    }
  });

  it('forwards isCancelled to the workflow worker (cancelled decision, no crash)', async () => {
    const rt = new DurableWorkerRuntime();
    rt.registerWorkflow('wf', async (ctx) => {
      await ctx.step('s', () => 1);
    });
    const out = await rt.handleTask(workflowTask(), { isCancelled: (id) => id === 'r1' });
    expect(out.kind).toBe('decision');
    if (out.kind === 'decision') expect(out.decision.status).toBe('cancelled');
  });

  it('forwards onStep so the shell can stream local step lifecycle', async () => {
    const rt = new DurableWorkerRuntime();
    rt.registerWorkflow('wf', async (ctx) => {
      await ctx.step('s', () => 1);
      return 'done';
    });
    const phases: string[] = [];
    const out = await rt.handleTask(workflowTask(), {
      onStep: (e) => phases.push(e.phase),
    });
    expect(out.kind).toBe('decision');
    expect(phases).toContain('completed');
  });

  it('an unknown workflow yields a failed decision (not a crash)', async () => {
    const rt = new DurableWorkerRuntime();
    const out = await rt.handleTask(workflowTask({ workflow: 'nope' }));
    expect(out.kind).toBe('decision');
    if (out.kind === 'decision') {
      expect(out.decision.status).toBe('failed');
      expect(out.decision.error?.code).toBe('no_workflow');
    }
  });

  it('an unknown step yields a failed result (not a crash)', async () => {
    const rt = new DurableWorkerRuntime();
    const out = await rt.handleTask(remoteTask({ name: 'nope' }));
    expect(out.kind).toBe('result');
    if (out.kind === 'result') {
      expect(out.result.status).toBe('failed');
      expect(out.result.error?.message).toContain('no handler for nope');
    }
  });
});
