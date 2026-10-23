import {
  DURABLE_STEP_NAME,
  InMemoryStateStore,
  type StateStore,
  type StepRef,
  type StepResult,
  type Transport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';

/** The step every case fans out over. */
export const STEP_FAN_STEP = 'fan-results-double';

/** Two engine-side transports on one broker (two instances of a deployment) and the worker side. */
export interface StepFanResultsHarness {
  /**
   * Fresh queues (prefix, tables) for one case: two engine-side transports, and a worker serving
   * {@link STEP_FAN_STEP} with `handler` (registered on whichever transport the backend runs
   * workers on). `close` releases everything the case opened.
   */
  open(
    handler: (input: unknown) => Promise<unknown>,
  ): Promise<{ engines: [Transport, Transport]; close: () => Promise<void> }>;
}

/** Builds the harness, or returns why the backend is unavailable (no Docker, say): the case skips. */
export type StepFanResultsHarnessFactory = () => Promise<StepFanResultsHarness | string>;

export interface StepFanResultsContractOptions {
  /** Per-case budget. Default 60s. */
  timeoutMs?: number;
  /** Steps in the fan. Default 2000. */
  fanSize?: number;
  /**
   * The fewest results the largest batched write of a backlog settles. Default 8: a consumer that
   * hands the engine one result at a time settles a fan in one write and one barrier read each.
   */
  minBatch?: number;
}

const doubleLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(doubleLine as unknown as { [DURABLE_STEP_NAME]: string })[DURABLE_STEP_NAME] = STEP_FAN_STEP;

interface Counts {
  calls: Map<string, number>;
  batches: number[];
}

/**
 * `inner`, counting calls and the size of each batched write. Every call answers a turn of the
 * event loop later, as a database does, so an in-memory store batches as a real one would.
 */
function counted(inner: StateStore, counts: Counts): StateStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const name = String(prop);
        counts.calls.set(name, (counts.calls.get(name) ?? 0) + 1);
        if (name === 'saveCheckpointsIfPending') counts.batches.push((args[0] as unknown[]).length);
        if (name === 'saveCheckpointIfPending') counts.batches.push(1);
        return new Promise((resolve) => setImmediate(resolve)).then(() =>
          value.apply(target, args),
        );
      };
    },
  });
}

/** `transport`, handing each result to the engine only once `gate` resolved. */
function behind(transport: Transport, gate: Promise<void>): Transport {
  return new Proxy(transport, {
    get(target, prop, receiver) {
      if (prop === 'onResult') {
        return (handler: (result: StepResult) => Promise<void>) =>
          target.onResult(async (result) => {
            await gate;
            return handler(result);
          });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met');
}

/** The fan forms every case runs for; `waves` > 1 sets `concurrency` to send the fan in that many. */
const FORMS = [
  { form: 'ctx.all', settle: false, waves: 1 },
  { form: 'ctx.allSettled', settle: true, waves: 1 },
  { form: 'ctx.all with concurrency', settle: false, waves: 4 },
  { form: 'ctx.allSettled with concurrency', settle: true, waves: 4 },
] as const;

/**
 * A wide step fan (`ctx.all` / `ctx.allSettled` over a `@Step`) whose results come back over a
 * real broker to two engine instances: every step settles once, the parent wakes O(1) times per
 * wave, and the results consumer hands the engine enough results at once that they are written in
 * batches rather than one by one.
 */
export function runStepFanResultsContract(
  name: string,
  makeHarness: StepFanResultsHarnessFactory,
  options: StepFanResultsContractOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const fanSize = options.fanSize ?? 2000;
  const minBatch = options.minBatch ?? 8;

  describe(`Step fan results contract: ${name}`, () => {
    for (const { form, settle, waves } of FORMS) {
      const size = waves === 1 ? fanSize : Math.floor(fanSize / 2);
      const concurrency = waves === 1 ? undefined : Math.ceil(size / waves);
      it(
        `settles a ${form} fan of ${size} steps over two instances in batches`,
        async (ctx) => {
          const harness = await makeHarness();
          if (typeof harness === 'string') {
            console.warn(`[step-fan-results contract] ${name} skipped: ${harness}`);
            ctx.skip();
            return;
          }
          const failing = settle ? new Set([1, size - 2]) : new Set<number>();
          // The engines take no result until the first wave has run: its results wait on the
          // broker, a backlog like a wide fan's whose steps finish faster than results are applied.
          let ran = 0;
          let openBacklog!: () => void;
          const backlog = new Promise<void>((resolve) => {
            openBacklog = resolve;
          });
          const { engines: opened, close } = await harness.open(async (input) => {
            ran += 1;
            if (ran >= (concurrency ?? size)) openBacklog();
            const { i } = input as { i: number };
            if (failing.has(i)) throw Object.assign(new Error(`bad ${i}`), { retryable: false });
            return i * 2;
          });
          const transports = opened.map((t) => behind(t, backlog));
          const inner = new InMemoryStateStore();
          const counts: Counts = { calls: new Map(), batches: [] };
          let turns = 0;
          const settled = new Map<number, number>();
          const engines = transports.map((transport) => {
            const engine = new WorkflowEngine({
              store: counted(inner, counts),
              transport,
              reconcileMs: 0,
            });
            engine.register('fan', '1', async (c) => {
              turns += 1;
              const inputs = Array.from({ length: size }, (_, i) => ({ i }));
              const opts = concurrency === undefined ? {} : { concurrency };
              if (!settle) return c.all(doubleLine, inputs, opts);
              const all = await c.allSettled(doubleLine, inputs, opts);
              return all.map((s) => (s.status === 'fulfilled' ? s.value : 'failed'));
            });
            engine.subscribe((e) => {
              if (
                (e.type === 'step.completed' || e.type === 'step.failed') &&
                e.seq !== undefined
              ) {
                settled.set(e.seq, (settled.get(e.seq) ?? 0) + 1);
              }
            });
            return engine;
          });
          try {
            await (engines[0] as WorkflowEngine).start('fan', {}, 'p');
            await until(async () => {
              const status = (await inner.getRun('p'))?.status;
              return status === 'completed' || status === 'failed';
            }, timeoutMs - 5_000);
            const run = await inner.getRun('p');
            expect(run?.status).toBe('completed');
            expect(run?.output).toEqual(
              Array.from({ length: size }, (_, i) => (failing.has(i) ? 'failed' : i * 2)),
            );
            expect(settled.size).toBe(size);
            expect([...settled.values()].every((n) => n === 1)).toBe(true);
            const barrierReads = counts.calls.get('countCheckpoints') ?? 0;
            expect(Math.max(...counts.batches)).toBeGreaterThanOrEqual(minBatch);
            if (waves === 1) expect(barrierReads).toBeLessThanOrEqual(size / minBatch);
            // The dispatching turn and one per settled wave, plus a spare per wave when both
            // instances see its barrier open at once, plus one per batch holding a failure.
            expect(turns).toBeLessThanOrEqual(1 + 2 * waves + failing.size);
          } finally {
            await close();
          }
        },
        timeoutMs,
      );
    }
  });
}
