import { SQSClient } from '@aws-sdk/client-sqs';
import {
  InMemoryStateStore,
  type RemoteStepDef,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SqsTransport } from './sqs-transport';

/**
 * Real-broker matrix for the SQS transport: an ElasticMQ container (speaks the SQS API) spun up via
 * testcontainers, so the remote-step round-trip and the failed-result path are exercised against an
 * actual SQS-compatible broker instead of self-skipping. Run with `pnpm test:db`.
 *
 * ElasticMQ returns queue URLs with its own advertised host (`localhost:9324`), which won't match
 * the container's randomly-mapped port. The AWS SDK v3 SQS client rewrites the queue URL's host/port
 * to the configured `endpoint`, so pointing the client at the mapped endpoint is enough — no custom
 * ElasticMQ `node-address` config needed.
 *
 * Skips cleanly when Docker is unavailable or `SKIP_TESTCONTAINERS` is set.
 */

const CONTAINER_TIMEOUT = 180_000;
const ELASTICMQ_PORT = 9324;
const skipped = !!process.env.SKIP_TESTCONTAINERS;

let container: StartedTestContainer | undefined;
let containerError: unknown;
let clientConfig:
  | {
      region: string;
      endpoint: string;
      credentials: { accessKeyId: string; secretAccessKey: string };
    }
  | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    container = await new GenericContainer('softwaremill/elasticmq-native:1.6.7')
      .withExposedPorts(ELASTICMQ_PORT)
      .withWaitStrategy(Wait.forLogMessage(/Started SQS rest server/i))
      .start();
    clientConfig = {
      region: 'elasticmq',
      endpoint: `http://${container.getHost()}:${container.getMappedPort(ELASTICMQ_PORT)}`,
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
    };
    // Sanity probe so a startup error surfaces here rather than mid-test.
    const probe = new SQSClient(clientConfig);
    const { ListQueuesCommand } = await import('@aws-sdk/client-sqs');
    await probe.send(new ListQueuesCommand({}));
    probe.destroy();
  } catch (err) {
    containerError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await container?.stop();
});

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

/** Resolve the live client config or self-skip the case when Docker isn't available. */
function liveConfig(ctx: { skip: () => void }): NonNullable<typeof clientConfig> {
  if (skipped || containerError || !clientConfig) {
    ctx.skip();
    throw new Error('unreachable'); // ctx.skip() aborts; keeps the type non-undefined
  }
  return clientConfig;
}

describe('SqsTransport (real ElasticMQ) [testcontainers]', () => {
  it('dispatches a remote step over SQS and returns the checkpointed result', async (ctx) => {
    const clientConfig = liveConfig(ctx);
    const prefix = `durtest-${Date.now()}`;
    const transport = new SqsTransport({
      clientConfig,
      group: 'payments',
      prefix,
      autoCreate: true,
    });
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
    const clientConfig = liveConfig(ctx);
    const prefix = `durtest-${Date.now()}-f`;
    const transport = new SqsTransport({
      clientConfig,
      group: 'payments',
      prefix,
      autoCreate: true,
    });
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
