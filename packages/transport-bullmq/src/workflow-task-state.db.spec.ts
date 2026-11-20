import type { WorkflowTask } from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * `workflowTaskState` against a real Redis: the engine asks it when a dispatched turn's deadline
 * lapsed, and counts the turn as lost only when a worker took the task. A task still waiting in a
 * backed-up queue reads `queued`; one a worker started (and, here, died holding, so BullMQ moved it
 * back for redelivery) reads `taken`; one that is gone reads `unknown`. Uses
 * `DURABLE_TEST_REDIS_URL` when set, else a testcontainer. Run with `pnpm test:db`.
 */
const externalUrl = process.env.DURABLE_TEST_REDIS_URL;
let container: StartedRedisContainer | undefined;
let connection: { host: string; port: number } | undefined;

beforeAll(async () => {
  if (externalUrl) {
    const u = new URL(externalUrl);
    connection = { host: u.hostname, port: Number(u.port || 6379) };
    return;
  }
  container = await new RedisContainer('redis:7-alpine').start();
  connection = { host: container.getHost(), port: container.getFirstMappedPort() };
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const task = (taskId: string): WorkflowTask => ({
  taskId,
  runId: 'r1',
  workflow: 'wf',
  workflowVersion: '1',
  input: {},
  history: [],
  group: 'wf',
  attempt: 1,
});

describe('BullMQTransport.workflowTaskState (real Redis)', () => {
  it('reads queued, then taken once a worker started it and stalled, then unknown once gone', async () => {
    const prefix = `wts-${Math.random().toString(36).slice(2)}`;
    const transport = new BullMQTransport({ connection: connection as never, prefix });
    const queueName = `${prefix}-tasks-wf`;
    try {
      await transport.dispatchWorkflowTask(task('r1:wf:aaaa1111'));
      expect(await transport.workflowTaskState('wf', 'r1:wf:aaaa1111')).toBe('queued');
      expect(await transport.workflowTaskState('wf', 'r1:wf:never')).toBe('unknown');

      // A worker takes the job and "dies" holding it: its lock lapses, and a stall check moves it
      // back to the queue for redelivery. It was taken, so a lapse now is a lost turn.
      let taken!: () => void;
      const started = new Promise<void>((resolve) => {
        taken = resolve;
      });
      const dying = new Worker(
        queueName,
        async () => {
          taken();
          await new Promise(() => {}); // never finishes
        },
        { connection: connection as never, lockDuration: 1_000, autorun: false },
      );
      // Stop renewing the lock, as a process that died would.
      (dying as unknown as { extendLocks: () => Promise<void> }).extendLocks = async () => {};
      void dying.run();
      await started;
      expect(await transport.workflowTaskState('wf', 'r1:wf:aaaa1111')).toBe('taken');
      await delay(1_500);
      const checker = new Worker(queueName, null, {
        connection: connection as never,
        autorun: false,
      });
      await (checker as unknown as { moveStalledJobsToWait: () => Promise<unknown> })
        .moveStalledJobsToWait()
        .catch(() => undefined);
      expect(await transport.workflowTaskState('wf', 'r1:wf:aaaa1111')).toBe('taken');
      await checker.close(true);
      await dying.close(true);

      // Gone (finished and removed, or failed past retention): unknown.
      const queue = new Queue(queueName, { connection: connection as never });
      await queue.obliterate({ force: true });
      await queue.close();
      expect(await transport.workflowTaskState('wf', 'r1:wf:aaaa1111')).toBe('unknown');
    } finally {
      await transport.close();
    }
  }, 60_000);
});
