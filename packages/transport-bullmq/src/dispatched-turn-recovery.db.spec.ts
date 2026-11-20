import {
  InMemoryStateStore,
  RemoteWorkflowExecutor,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * The lost-turn count end to end against a real BullMQ: the engine dispatches a workflow turn through
 * `RemoteWorkflowExecutor` onto the transport's task queue, and when the turn's deadline lapses it
 * asks `RemoteWorkflowExecutor.taskState` → `BullMQTransport.workflowTaskState`, which finds the job
 * by the id the dispatch gave it. While the job waits unstarted nothing is counted or re-dispatched;
 * once a worker took it and died with it, the lapse is counted and the turn dispatched again. Uses
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

const SILENCE_MS = 60_000;

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met');
}

describe('a dispatched turn lost on a real BullMQ', () => {
  it('is not counted while its job waits unstarted, and is once a worker took it and died', async () => {
    const prefix = `dtr-${Math.random().toString(36).slice(2)}`;
    const transport = new BullMQTransport({ connection: connection as never, prefix });
    const store = new InMemoryStateStore();
    const clock = { now: Date.now() };
    const engine = new WorkflowEngine({
      store,
      transport,
      clock: () => clock.now,
      reconcileMs: 0,
      remoteAdvanceSilenceMs: SILENCE_MS,
      maxRecoveryAttempts: 5,
    });
    engine.registerRemote('wf', '1', {
      group: 'wf',
      executor: new RemoteWorkflowExecutor(transport, 'wf'),
    });
    const queue = new Queue(`${prefix}-tasks-wf`, { connection: connection as never });
    const jobs = async () => (await queue.getJobs(['waiting', 'active', 'prioritized'])).length;
    const attempts = async () => (await store.getRun('r1'))?.recoveryAttempts ?? 0;
    // Past the engine's boot window, so no lapse below is postponed for a restart.
    clock.now += SILENCE_MS + 1;
    let dying: Worker | undefined;
    try {
      await engine.start('wf', {}, 'r1');
      await until(async () => (await jobs()) === 1);
      const firstTurn = (await store.getRun('r1'))?.awaitingDecisionTaskId;
      expect(firstTurn).toMatch(/^r1:wf:[0-9a-f]{8}$/);

      // Nobody consumes the queue yet: a backed-up queue, not a lost turn.
      clock.now += SILENCE_MS + 1;
      await engine.resumeDueTimers(clock.now);
      expect(await attempts()).toBe(0);
      expect(await jobs()).toBe(1);

      // A worker takes the job and dies holding it (its lock is never renewed).
      let taken!: () => void;
      const started = new Promise<void>((resolve) => {
        taken = resolve;
      });
      dying = new Worker(
        `${prefix}-tasks-wf`,
        async () => {
          taken();
          await new Promise(() => {});
        },
        { connection: connection as never, lockDuration: 1_000, autorun: false },
      );
      (dying as unknown as { extendLocks: () => Promise<void> }).extendLocks = async () => {};
      void dying.run();
      await started;
      await dying.close(true);
      dying = undefined;

      // The pushed-out deadline lapses again: now it is a lost turn, counted and dispatched again.
      clock.now += SILENCE_MS + 1;
      await engine.resumeDueTimers(clock.now);
      await until(async () => (await attempts()) === 1);
      // The next turn is dispatched under a fresh task id, onto the same queue.
      await until(async () => {
        const marker = (await store.getRun('r1'))?.awaitingDecisionTaskId;
        return marker !== undefined && marker !== firstTurn && !marker.endsWith(':lost');
      });
      const next = (await store.getRun('r1'))?.awaitingDecisionTaskId as string;
      expect(await transport.workflowTaskState('wf', next)).toBe('queued');
    } finally {
      await dying?.close(true);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      await engine.drain().catch(() => undefined);
      await transport.close();
    }
  }, 60_000);
});
