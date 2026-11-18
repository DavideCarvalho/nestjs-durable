import { describe, expect, it } from 'vitest';
import {
  REMOTE_WORKFLOW_FEATURES,
  type Transport,
  type WorkflowRun,
  type WorkflowTask,
} from './interfaces';
import { remoteCallPolicyOf, remoteCallRetries } from './remote-call-policy';
import { RemoteWorkflowExecutor } from './remote-workflow-executor';

describe('remoteCallPolicyOf', () => {
  it('merges the @Step config with per-call opts, the opts winning field by field', () => {
    expect(
      remoteCallPolicyOf(
        { retries: 4, backoff: 'exp', backoffMs: 100, requires: ['gpu'] },
        { backoffMs: 5, timeoutMs: 1_000, priority: 2 },
      ),
    ).toEqual({ retries: 4, backoff: 'exp', backoffMs: 5, timeoutMs: 1_000 });
  });

  it('is undefined when nothing declares a policy (the call stays wire-identical)', () => {
    expect(remoteCallPolicyOf(undefined, { priority: 1, queue: 'q' })).toBeUndefined();
    expect(remoteCallPolicyOf({ requires: ['gpu'] }, undefined)).toBeUndefined();
  });
});

describe('remoteCallRetries — the in-process retry rule', () => {
  it('retries a retryable failure while attempts remain', () => {
    expect(remoteCallRetries({ retries: 3 }, 1, { message: 'x' })).toBe(true);
    expect(remoteCallRetries({ retries: 3 }, 2, { message: 'x' })).toBe(true);
    expect(remoteCallRetries({ retries: 3 }, 3, { message: 'x' })).toBe(false);
  });

  it('never retries without a policy, a non-retryable error, or under a timeoutMs', () => {
    expect(remoteCallRetries(undefined, 1, { message: 'x' })).toBe(false);
    expect(remoteCallRetries({ retries: 3 }, 1, { message: 'x', retryable: false })).toBe(false);
    expect(remoteCallRetries({ retries: 3, timeoutMs: 10 }, 1, { message: 'x' })).toBe(false);
  });

  it('treats retries 0/1/unset as a single attempt', () => {
    expect(remoteCallRetries({ retries: 0 }, 1, { message: 'x' })).toBe(false);
    expect(remoteCallRetries({ backoffMs: 10 }, 1, { message: 'x' })).toBe(false);
  });
});

describe('RemoteWorkflowExecutor feature negotiation', () => {
  it('advertises every workflow-decision feature this control plane applies on the task', async () => {
    const sent: WorkflowTask[] = [];
    const transport = {
      dispatchWorkflowTask: async (task: WorkflowTask) => {
        sent.push(task);
      },
    } as unknown as Transport;
    const run = { id: 'r1', workflow: 'wf', workflowVersion: '1', input: 1 } as WorkflowRun;
    await new RemoteWorkflowExecutor(transport, 'wf', 'acme').dispatch(run, [], 't1');
    expect(sent[0]?.features).toEqual([...REMOTE_WORKFLOW_FEATURES]);
    expect(sent[0]?.features).toEqual(
      expect.arrayContaining([
        'callPolicy',
        'sleepUntil',
        'waitSignalTimeout',
        'waitEvent',
        'spawnChild',
        'continueAsNew',
      ]),
    );
  });
});
