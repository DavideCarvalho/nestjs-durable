import { describe, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, RemoteTask, StateStore, StepResult, Transport } from './interfaces';
import { DURABLE_STEP_NAME, type StepRef } from './step-name-symbol';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * Throughput harness (not a regression test): a wide step fan over several engine instances that
 * share one store with per-call latency and a per-instance connection-pool cap, and a broker whose
 * results consumers each take at most `consumerConcurrency` results at a time. Run with
 * `DURABLE_HARNESS=1 pnpm vitest run packages/core/src/fan-result-throughput.harness.spec.ts`.
 */

const STEP = 'Lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as unknown as { [DURABLE_STEP_NAME]: string })[DURABLE_STEP_NAME] = STEP;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    else this.active += 1;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

interface Stats {
  calls: Map<string, number>;
  batchSizes: number[];
  countRows: number;
}

/** One instance's view of the shared store: its own pool, fixed latency, a count costs per row. */
function latentStore(
  inner: InMemoryStateStore,
  stats: Stats,
  opts: { latencyMs: number; pool: number; countUsPerRow: number; writeMsPerRow: number },
): StateStore {
  const pool = new Semaphore(opts.pool);
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const name = String(prop);
        stats.calls.set(name, (stats.calls.get(name) ?? 0) + 1);
        let cost = opts.latencyMs;
        if (name === 'countCheckpoints') {
          const rows = (args[2] as number) - (args[1] as number) + 1;
          stats.countRows += rows;
          cost += (rows * opts.countUsPerRow) / 1000;
        }
        if (name === 'settleCheckpointsIfPending' || name === 'saveCheckpointsIfPending') {
          const n = (args[0] as unknown[]).length;
          stats.batchSizes.push(n);
          cost += n * opts.writeMsPerRow;
        }
        if (name === 'saveCheckpointIfPending') stats.batchSizes.push(1);
        return pool.run(async () => {
          await sleep(cost);
          return value.apply(target, args);
        });
      };
    },
  });
}

/** A point-to-point broker: tasks run on a shared worker pool, results go to one shared queue. */
class Broker {
  readonly results: StepResult[] = [];
  readonly consumers: Consumer[] = [];
  private readonly workers: Semaphore;
  constructor(
    workers: number,
    private readonly stepMs: number,
  ) {
    this.workers = new Semaphore(workers);
  }
  run(task: RemoteTask): void {
    void this.workers.run(async () => {
      await sleep(this.stepMs);
      this.results.push({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output: (task.input as { i: number }).i,
      });
      this.pump();
    });
  }
  pump(): void {
    for (const c of this.consumers) c.pull();
  }
}

class Consumer implements Transport {
  handler?: (r: StepResult) => Promise<void>;
  active = 0;
  constructor(
    private readonly broker: Broker,
    private readonly concurrency: number,
  ) {
    broker.consumers.push(this);
  }
  async dispatch(task: RemoteTask): Promise<void> {
    this.broker.run(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.handler = handler;
  }
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}
  pull(): void {
    while (this.handler && this.active < this.concurrency && this.broker.results.length > 0) {
      const result = this.broker.results.shift() as StepResult;
      this.active += 1;
      // A fetch round-trip to the broker, like BullMQ's moveToActive.
      void sleep(0.3)
        .then(() => this.handler?.(result))
        .catch(() => this.broker.results.push(result))
        .finally(() => {
          this.active -= 1;
          this.broker.pump();
        });
    }
  }
}

async function scenario(opts: {
  fan: number;
  instances: number;
  consumerConcurrency: number;
  concurrency?: number;
  settle?: boolean;
}) {
  const inner = new InMemoryStateStore();
  const stats: Stats = { calls: new Map(), batchSizes: [], countRows: 0 };
  const broker = new Broker(48, 2);
  let turns = 0;
  const engines: WorkflowEngine[] = [];
  for (let k = 0; k < opts.instances; k += 1) {
    const store = latentStore(inner, stats, {
      latencyMs: 2,
      pool: 10,
      countUsPerRow: 2,
      writeMsPerRow: 0.05,
    });
    const engine = new WorkflowEngine({
      store,
      transport: new Consumer(broker, opts.consumerConcurrency),
      reconcileMs: 0,
    });
    engine.register('fan', '1', async (ctx) => {
      turns += 1;
      const inputs = Array.from({ length: opts.fan }, (_, i) => ({ i }));
      const all = opts.settle
        ? await ctx.allSettled(processLine, inputs, { concurrency: opts.concurrency })
        : await ctx.all(processLine, inputs, { concurrency: opts.concurrency });
      return all.length;
    });
    engines.push(engine);
  }
  let firstSettle = 0;
  (engines[0] as WorkflowEngine).subscribe((e) => {
    if (e.type === 'step.completed' && firstSettle === 0) firstSettle = Date.now();
  });
  for (const e of engines.slice(1)) {
    e.subscribe((ev) => {
      if (ev.type === 'step.completed' && firstSettle === 0) firstSettle = Date.now();
    });
  }
  const started = Date.now();
  await (engines[0] as WorkflowEngine).start('fan', {}, 'p');
  for (;;) {
    const run = await inner.getRun('p');
    if (run?.status === 'completed' || run?.status === 'failed') break;
    await sleep(20);
  }
  const ms = Date.now() - started;
  const settleMs = Date.now() - firstSettle;
  const calls = [...stats.calls.entries()].sort();
  const resultCalls =
    (stats.calls.get('getCheckpoint') ?? 0) +
    (stats.calls.get('getCheckpoints') ?? 0) +
    (stats.calls.get('getCheckpointsForSettle') ?? 0) +
    (stats.calls.get('settleCheckpointsIfPending') ?? 0) +
    (stats.calls.get('saveCheckpointsIfPending') ?? 0) +
    (stats.calls.get('saveCheckpointIfPending') ?? 0) +
    (stats.calls.get('countCheckpoints') ?? 0) +
    (stats.calls.get('getRun') ?? 0);
  const sizes = stats.batchSizes;
  const mean = sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length);
  console.log(
    JSON.stringify({
      ...opts,
      totalMs: ms,
      settleMs,
      resultsPerSec: Math.round((opts.fan / settleMs) * 1000),
      turns,
      batches: sizes.length,
      meanBatch: Math.round(mean * 10) / 10,
      maxBatch: Math.max(...sizes),
      barrierCounts: stats.calls.get('countCheckpoints') ?? 0,
      countRowsPerResult: Math.round(stats.countRows / opts.fan),
      resultPathCallsPerResult: Math.round((resultCalls / opts.fan) * 100) / 100,
      calls: Object.fromEntries(calls),
    }),
  );
  for (const e of engines) await e.close?.();
}

const enabled = process.env.DURABLE_HARNESS === '1';
const fan = Number(process.env.DURABLE_HARNESS_FAN ?? 20000);
const instances = Number(process.env.DURABLE_HARNESS_INSTANCES ?? 6);
const consumer = Number(process.env.DURABLE_HARNESS_CONSUMER ?? 4);

describe.runIf(enabled)('fan result throughput harness', () => {
  it(
    'ctx.all step fan',
    async () => {
      await scenario({ fan, instances, consumerConcurrency: consumer });
    },
    60 * 60_000,
  );
});
