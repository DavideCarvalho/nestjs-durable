import type { RemoteTask, WorkflowTask } from '@dudousxd/nestjs-durable-core';
import type { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { BullMQTransport, toBrokerPriority } from './bullmq-transport';

/** Captures every `.add(name, data, opts)` so we can assert the job options the transport built. */
class RecordingQueue {
  readonly added: Array<{ name: string; data: unknown; opts: unknown }> = [];
  async add(name: string, data: unknown, opts: unknown) {
    this.added.push({ name, data, opts });
  }
}

/** A transport whose queues are recording fakes — exercises the real dispatch path without Redis. */
class TestTransport extends BullMQTransport {
  readonly recorded = new RecordingQueue();
  protected override createQueue(): Queue {
    return this.recorded as unknown as Queue;
  }
}

function remoteTask(priority?: number): RemoteTask {
  return {
    runId: 'r1',
    seq: 0,
    name: 'payments.charge-card',
    stepId: 'r1:0',
    group: 'payments',
    input: { amount: 1 },
    attempt: 1,
    ...(priority != null ? { priority } : {}),
  };
}

function workflowTask(priority?: number): WorkflowTask {
  return {
    taskId: 'r1:wf:1',
    runId: 'r1',
    workflow: 'processing',
    workflowVersion: '1',
    input: {},
    history: [],
    group: 'processing-workflows',
    attempt: 1,
    ...(priority != null ? { priority } : {}),
  };
}

function optPriority(rec: RecordingQueue, i = 0): number | undefined {
  return (rec.added[i]?.opts as { priority?: number }).priority;
}

describe('toBrokerPriority — maps the lib "higher wins" scale onto BullMQ "lower wins"', () => {
  it('returns undefined for an absent priority (keeps the FIFO default path)', () => {
    expect(toBrokerPriority(undefined)).toBeUndefined();
  });

  it('maps a higher lib priority to a lower BullMQ number (more urgent)', () => {
    const urgent = toBrokerPriority(9);
    const normalish = toBrokerPriority(3);
    expect(urgent).toBeDefined();
    expect(normalish).toBeDefined();
    expect(urgent as number).toBeLessThan(normalish as number);
  });

  it('clamps into BullMQ valid range [1, 2097151]', () => {
    expect(toBrokerPriority(10_000_000)).toBe(1);
    expect(toBrokerPriority(-10_000_000)).toBe(2_097_151);
  });

  it('rounds non-integer priorities to a valid integer', () => {
    expect(Number.isInteger(toBrokerPriority(2.7))).toBe(true);
  });
});

describe('BullMQ transport forwards a translated priority to the broker job', () => {
  it('passes a remote step priority into the BullMQ add() options', async () => {
    const transport = new TestTransport({ connection: { host: 'unused', port: 0 } });
    await transport.dispatch(remoteTask(9));
    expect(transport.recorded.added).toHaveLength(1);
    expect(optPriority(transport.recorded)).toBe(toBrokerPriority(9));
  });

  it('passes a workflow task priority into the BullMQ add() options', async () => {
    const transport = new TestTransport({ connection: { host: 'unused', port: 0 } });
    await transport.dispatchWorkflowTask(workflowTask(3));
    expect(transport.recorded.added).toHaveLength(1);
    expect(optPriority(transport.recorded)).toBe(toBrokerPriority(3));
  });

  it('does not set a priority option when the task has none', async () => {
    const transport = new TestTransport({ connection: { host: 'unused', port: 0 } });
    await transport.dispatch(remoteTask());
    expect(optPriority(transport.recorded)).toBeUndefined();
  });
});
