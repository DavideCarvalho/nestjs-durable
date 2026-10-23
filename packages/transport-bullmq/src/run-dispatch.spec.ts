import { describe, expect, it, vi } from 'vitest';

/**
 * The run queue of BullMQTransport, offline: bullmq and ioredis are mocked (as in start-run.spec.ts)
 * to pin the queue names, job ids, bulk chunking, priority and consumer concurrency. The behavior
 * against a real Redis is the shared run-dispatch contract in run-dispatch.db.spec.ts.
 */

interface Bulk {
  queue: string;
  jobs: { name: string; data: { runId: string }; opts: Record<string, unknown> }[];
}
const bulks: Bulk[] = [];
const workers: {
  name: string;
  opts: { concurrency?: number };
  processor: (job: { data: unknown }) => Promise<unknown>;
  close: ReturnType<typeof vi.fn>;
  listeners: Map<string, (job: { data: unknown }) => void>;
}[] = [];
// The re-dispatch marks, as Redis would hold them.
const marks = new Map<string, string>();

vi.mock('bullmq', () => ({
  Queue: vi.fn((name: string) => ({
    add: vi.fn(async () => undefined),
    addBulk: vi.fn(async (jobs: Bulk['jobs']) => {
      bulks.push({ queue: name, jobs });
    }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  Worker: vi.fn(
    (
      name: string,
      processor: (job: { data: unknown }) => Promise<unknown>,
      opts: { concurrency?: number },
    ) => {
      const close = vi.fn().mockResolvedValue(undefined);
      const listeners = new Map<string, (job: { data: unknown }) => void>();
      workers.push({ name, opts, processor, close, listeners });
      return {
        concurrency: opts.concurrency ?? 1,
        close,
        on: (event: string, listener: (job: { data: unknown }) => void) => {
          listeners.set(event, listener);
        },
      };
    },
  ),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    disconnect: vi.fn(),
    pipeline: () => {
      const ops: [string, string][] = [];
      const p = {
        set: (key: string, value: string) => {
          ops.push([key, value]);
          return p;
        },
        exec: async () => {
          for (const [k, v] of ops) marks.set(k, v);
          return [];
        },
      };
      return p;
    },
    del: async (key: string) => (marks.delete(key) ? 1 : 0),
    getdel: async (key: string) => {
      const v = marks.get(key) ?? null;
      marks.delete(key);
      return v;
    },
  })),
}));

const { BullMQTransport, runJobId, toBrokerPriority } = await import('./bullmq-transport');

const connection = { host: '127.0.0.1', port: 6379 };

describe('BullMQTransport run queue', () => {
  it('queues runs on <prefix>-runs with the run id as job id, 500 per addBulk', async () => {
    bulks.length = 0;
    const transport = new BullMQTransport({ connection, prefix: 'app' });
    const runs = Array.from({ length: 1200 }, (_, i) => ({ runId: `r${i}` }));
    await transport.dispatchRuns(runs);
    expect(bulks.map((b) => b.queue)).toEqual(['app-runs', 'app-runs', 'app-runs']);
    expect(bulks.map((b) => b.jobs.length)).toEqual([500, 500, 200]);
    expect(bulks.flatMap((b) => b.jobs.map((j) => j.opts.jobId))).toEqual(runs.map((r) => r.runId));
    expect(bulks[0]?.jobs[0]).toMatchObject({
      name: 'run',
      data: { runId: 'r0' },
      opts: { removeOnComplete: true, removeOnFail: true },
    });
    await transport.close();
  });

  it("maps a run's priority onto the job's, and leaves an unprioritised run without one", async () => {
    bulks.length = 0;
    const transport = new BullMQTransport({ connection });
    await transport.dispatchRuns([{ runId: 'hi', priority: 10 }, { runId: 'plain' }]);
    const [hi, plain] = bulks[0]?.jobs ?? [];
    expect(hi?.opts.priority).toBe(toBrokerPriority(10));
    expect(plain?.opts).not.toHaveProperty('priority');
    await transport.close();
  });

  it('escapes the `:` BullMQ rejects in a custom job id, reversibly', () => {
    expect(runJobId('evt:e1:onSignup')).toBe('evt%3Ae1%3AonSignup');
    expect(runJobId('a%3Ab')).toBe('a%253Ab');
    expect(runJobId('evt:e1')).not.toBe(runJobId('evt%3Ae1'));
  });

  it("uses a namespace's own queue, under the transport's namespace prefix", async () => {
    bulks.length = 0;
    const transport = new BullMQTransport({ connection, namespace: 'staging' });
    await transport.dispatchRuns([{ runId: 'r' }], { namespace: 'acme' });
    expect(bulks[0]?.queue).toBe('durable-staging-runs-acme');
    await transport.close();
  });

  it('consumes with a Worker of the given concurrency, handing it the run id', async () => {
    workers.length = 0;
    const transport = new BullMQTransport({ connection });
    const handled: string[] = [];
    const stop = transport.onDispatchedRun(async (runId) => void handled.push(runId), {
      concurrency: 256,
    });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.name).toBe('durable-runs');
    expect(workers[0]?.opts.concurrency).toBe(256);
    await workers[0]?.processor({ data: { runId: 'evt:e1:x' } });
    expect(handled).toEqual(['evt:e1:x']);
    await stop();
    expect(workers[0]?.close).toHaveBeenCalledTimes(1);
    await transport.close();
    // A stopped consumer is not closed a second time by the transport.
    expect(workers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('queues a run again when it was dispatched while its job was being handled', async () => {
    workers.length = 0;
    bulks.length = 0;
    marks.clear();
    const transport = new BullMQTransport({ connection });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    transport.onDispatchedRun(async () => gate, { concurrency: 1 });
    await transport.dispatchRuns([{ runId: 'r', priority: 3 }]);
    const worker = workers[0];
    // The job is taken (clearing the mark), and while it is handled the run is dispatched again:
    // BullMQ ignores the add (same job id), the mark records it.
    const handling = worker?.processor({ data: { runId: 'r', priority: 3 } });
    await new Promise((resolve) => setImmediate(resolve));
    await transport.dispatchRuns([{ runId: 'r', priority: 3 }]);
    release();
    await handling;
    bulks.length = 0;
    worker?.listeners.get('completed')?.({ data: { runId: 'r', priority: 3 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bulks.flatMap((b) => b.jobs.map((j) => j.data.runId))).toEqual(['r']);
    expect(bulks[0]?.jobs[0]?.opts.priority).toBe(toBrokerPriority(3));
    await transport.close();
  });

  it('does not queue a run again when it was only waiting when dispatched twice', async () => {
    workers.length = 0;
    bulks.length = 0;
    marks.clear();
    const transport = new BullMQTransport({ connection });
    transport.onDispatchedRun(async () => undefined, { concurrency: 1 });
    await transport.dispatchRuns([{ runId: 'w' }]);
    await transport.dispatchRuns([{ runId: 'w' }]);
    await workers[0]?.processor({ data: { runId: 'w' } });
    bulks.length = 0;
    workers[0]?.listeners.get('completed')?.({ data: { runId: 'w' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bulks).toEqual([]);
    await transport.close();
  });

  it('closes a consumer still running when the transport closes', async () => {
    workers.length = 0;
    const transport = new BullMQTransport({ connection });
    transport.onDispatchedRun(async () => undefined, { concurrency: 4 });
    await transport.close();
    expect(workers[0]?.close).toHaveBeenCalledTimes(1);
  });
});
