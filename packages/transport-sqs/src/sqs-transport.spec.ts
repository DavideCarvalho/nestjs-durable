import {
  InMemoryStateStore,
  type RemoteStepDef,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { SqsTransport } from './sqs-transport';

// ElasticMQ speaks the SQS API; flip runs it on :9324. Skip when it isn't up.
const clientConfig = {
  region: 'elasticmq',
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:9324',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
};

const chargeCard: RemoteStepDef<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge-card',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
  __remote: true,
};

/** A durable ctx.call suspends; poll the store until the SQS round-trip resumes it to terminal. */
async function settle(store: InMemoryStateStore, runId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended')
      return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not settle`);
}

let sqsUp = false;
beforeAll(async () => {
  const probe = new SQSClient(clientConfig);
  try {
    const { ListQueuesCommand } = await import('@aws-sdk/client-sqs');
    await probe.send(new ListQueuesCommand({}));
    sqsUp = true;
  } catch {
    sqsUp = false;
  }
  probe.destroy();
});

describe('SqsTransport (real ElasticMQ)', () => {
  it('dispatches a remote step over SQS and returns the checkpointed result', async (ctx) => {
    if (!sqsUp) ctx.skip();
    const prefix = `durtest-${Date.now()}`;
    const transport = new SqsTransport({ clientConfig, group: 'payments', prefix, autoCreate: true });
    transport.handle('payments.charge-card', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => {
      const charge = await c.call(chargeCard, { amount: 7 });
      return charge.chargeId;
    });

    await engine.start('checkout', {}, 'run1');
    const result = await settle(store, 'run1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('ch_7');

    await transport.close();
  }, 30_000);

  it('reports a failed result when the worker handler throws', async (ctx) => {
    if (!sqsUp) ctx.skip();
    const prefix = `durtest-${Date.now()}-f`;
    const transport = new SqsTransport({ clientConfig, group: 'payments', prefix, autoCreate: true });
    transport.handle('payments.charge-card', async () => {
      throw new Error('declined');
    });

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => c.call(chargeCard, { amount: 1 }));

    await engine.start('checkout', {}, 'run-f');
    const result = await settle(store, 'run-f');
    expect(result.status).toBe('failed');

    await transport.close();
  }, 30_000);
});
