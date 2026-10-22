import {
  InMemoryStateStore,
  type RunReply,
  type RunRequest,
  type StepCheckpoint,
  type Transport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { ProxyRunGateway } from './proxy-run-gateway';
import { RunRequestResponder } from './run-request-responder';
import { StoreRunGateway } from './store-run-gateway';

const at = new Date('2026-06-11T00:00:00.000Z');

/** A tenant's proxy wired to an operator's responder, with every message crossing as JSON. */
async function tenantOverOperator() {
  const store = new InMemoryStateStore();
  for (const [id, namespace] of [
    ['mine', 'acme'],
    ['theirs', 'beta'],
  ] as const) {
    await store.createRun({
      id,
      workflow: 'lines',
      workflowVersion: '1',
      status: 'suspended',
      input: {},
      namespace,
      createdAt: at,
      updatedAt: at,
    });
    for (let seq = 0; seq < 80; seq++) {
      const cp: StepCheckpoint = {
        runId: id,
        seq,
        name: 'Lines.process',
        kind: 'remote',
        stepId: `${id}:${seq}`,
        status: 'completed',
        attempts: 1,
        parallelGroup: 'steps:0:80',
        enqueuedAt: at,
        startedAt: at,
        finishedAt: at,
      };
      await store.saveCheckpoint(cp);
    }
  }
  const operator = new StoreRunGateway(store, new WorkflowEngine({ store }));
  let onRequest: ((msg: RunRequest) => Promise<void>) | undefined;
  let onReply: ((reply: RunReply) => void) | undefined;
  const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const transport = {
    dispatchRunRequest: async (msg: RunRequest) => {
      await onRequest?.(wire(msg));
    },
    onRunReply: (handler: (reply: RunReply) => void) => {
      onReply = handler;
    },
  } as unknown as Transport;
  new RunRequestResponder(
    {
      onRunRequest: (handler) => {
        onRequest = handler;
      },
      publishRunReply: async (reply) => onReply?.(wire(reply)),
    },
    operator,
  ).start();
  return { store, tenant: new ProxyRunGateway(transport, 'acme') };
}

describe('a tenant polling a run detail through the control plane', () => {
  it('gets the ETag back, and a notModified answer the operator built without the timeline', async () => {
    const { store, tenant } = await tenantOverOperator();
    const first = await tenant.getRunDetail('mine', { summarizeFansOver: 50 });
    expect(first?.fans).toHaveLength(1);
    const etag = first?.etag as string;
    expect(etag).toMatch(/^"rd-/);

    const reads = store.checkpointRowsRead;
    const again = await tenant.getRunDetail('mine', { summarizeFansOver: 50, ifNoneMatch: etag });
    expect(again).toMatchObject({ notModified: true, etag, timeline: [] });
    expect(store.checkpointRowsRead).toBe(reads);

    const page = await tenant.getFanMembers('mine', 'steps:0:80', { limit: 5 });
    const pageAgain = await tenant.getFanMembers('mine', 'steps:0:80', {
      limit: 5,
      ifNoneMatch: page?.etag,
    });
    expect(pageAgain).toMatchObject({ notModified: true, items: [] });
  });

  it("still refuses another tenant's run, even when its ETag is known", async () => {
    const { tenant } = await tenantOverOperator();
    await expect(
      tenant.getRunDetail('theirs', { summarizeFansOver: 50, ifNoneMatch: '*' }),
    ).rejects.toThrow(/another tenant/);
  });
});
