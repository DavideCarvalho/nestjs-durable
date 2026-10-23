import { CreateQueueCommand, ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { runRunDispatchContract } from '@dudousxd/nestjs-durable-testing';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll } from 'vitest';
import { SqsTransport } from './sqs-transport';

/**
 * The shared run-dispatch contract against ElasticMQ (an SQS-compatible broker, testcontainers):
 * two SqsTransports on one fresh run queue per case stand for two instances of a deployment, on a
 * standard queue and on a FIFO one. SQS does not deduplicate a waiting run, so the contract checks
 * that a run received twice runs one turn instead. Run with `pnpm test:db`. Uses
 * `DURABLE_TEST_SQS_ENDPOINT` (an ElasticMQ `http://host:port`) when set; skips when Docker is
 * unavailable or `SKIP_TESTCONTAINERS` is set.
 */

const ELASTICMQ_PORT = 9324;
let container: StartedTestContainer | undefined;
let unavailable: string | undefined;
let clientConfig:
  | {
      region: string;
      endpoint: string;
      credentials: { accessKeyId: string; secretAccessKey: string };
    }
  | undefined;
let cases = 0;

beforeAll(async () => {
  const externalEndpoint = process.env.DURABLE_TEST_SQS_ENDPOINT;
  if (!externalEndpoint && process.env.SKIP_TESTCONTAINERS) {
    unavailable = 'SKIP_TESTCONTAINERS is set';
    return;
  }
  try {
    clientConfig = {
      region: 'elasticmq',
      endpoint: externalEndpoint ?? (await startElasticMq()),
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
    };
    const probe = new SQSClient(clientConfig);
    await probe.send(new ListQueuesCommand({}));
    probe.destroy();
  } catch (err) {
    unavailable = `no ElasticMQ container: ${err instanceof Error ? err.message : String(err)}`;
  }
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

/** Boot an ElasticMQ testcontainer and return its SQS endpoint. */
async function startElasticMq(): Promise<string> {
  container = await new GenericContainer('softwaremill/elasticmq-native:1.6.7')
    .withExposedPorts(ELASTICMQ_PORT)
    .withWaitStrategy(Wait.forLogMessage(/Started SQS rest server/i))
    .start();
  return `http://${container.getHost()}:${container.getMappedPort(ELASTICMQ_PORT)}`;
}

for (const fifo of [false, true]) {
  runRunDispatchContract(
    `SqsTransport (ElasticMQ, ${fifo ? 'FIFO' : 'standard'} queue)`,
    async () => {
      if (unavailable || !clientConfig) return unavailable ?? 'no ElasticMQ';
      const config = clientConfig;
      return {
        pair: async () => {
          cases += 1;
          const prefix = `rd${cases}-${Date.now()}`;
          let runsQueueUrl: ((ns: string | undefined) => Promise<string>) | undefined;
          if (fifo) {
            const admin = new SQSClient(config);
            const created = await admin.send(
              new CreateQueueCommand({
                QueueName: `${prefix}-runs.fifo`,
                Attributes: { FifoQueue: 'true' },
              }),
            );
            admin.destroy();
            const url = created.QueueUrl as string;
            runsQueueUrl = async () => url;
          }
          const make = () =>
            new SqsTransport({
              clientConfig: config,
              prefix,
              autoCreate: true,
              waitTimeSeconds: 1,
              ...(runsQueueUrl ? { runsQueueUrl } : {}),
            });
          return [make(), make()];
        },
      };
    },
    { dedupesWaitingRuns: false },
  );
}
