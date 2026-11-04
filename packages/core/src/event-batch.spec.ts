import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { accumulatorRunId } from './event-accumulators';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const tick = () => new Promise((r) => setImmediate(r));
async function until(pred: () => boolean, n = 100) {
  for (let i = 0; i < n && !pred(); i += 1) await tick();
}

describe('onEvent debounce / batch', () => {
  it('debounce: coalesces a burst into one run with the last payload after the quiet window', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const fired: unknown[] = [];
    engine.register('handler', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['activity'],
      eventBatch: { mode: 'debounce', windowMs: 5000 },
    });

    await engine.publishEvent('activity', { v: 1 });
    await engine.waitForRun('__evtacc__:handler'); // accumulator parked on the debounce window
    await engine.publishEvent('activity', { v: 2 });
    await engine.publishEvent('activity', { v: 3 });
    await tick();
    expect(fired).toEqual([]); // nothing fired yet — still within the window

    now += 6000; // window elapses with no new event
    await engine.resumeDueTimers(now);
    await until(() => fired.length > 0);
    expect(fired).toEqual([{ v: 3 }]); // exactly one run, with the last payload
  });

  it('batch: fires one run with all payloads once maxSize is reached', async () => {
    const store = new InMemoryStateStore();
    const now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const fired: unknown[] = [];
    engine.register('agg', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['hit'],
      eventBatch: { mode: 'batch', maxSize: 3, windowMs: 60_000 },
    });

    await engine.publishEvent('hit', { n: 1 });
    await engine.waitForRun('__evtacc__:agg');
    await engine.publishEvent('hit', { n: 2 });
    await engine.publishEvent('hit', { n: 3 }); // hits maxSize → fires
    await until(() => fired.length > 0);
    expect(fired).toEqual([{ events: [{ n: 1 }, { n: 2 }, { n: 3 }] }]);
  });
});

describe('onEvent debounce / batch per key', () => {
  it('debounce: each key gets its own accumulator and run; the same key coalesces', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const fired: unknown[] = [];
    engine.register('refresh', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: [
        {
          event: 'ingested',
          input: (p) => ({ base: (p as { base: string }).base, v: (p as { v: number }).v }),
        },
      ],
      eventBatch: {
        mode: 'debounce',
        windowMs: 5000,
        key: (input) => (input as { base: string }).base,
      },
    });

    await engine.publishEvent('ingested', { base: 'b1', v: 1 });
    await engine.publishEvent('ingested', { base: 'b2', v: 1 });
    await engine.waitForRun(accumulatorRunId('refresh', 'b1'));
    await engine.waitForRun(accumulatorRunId('refresh', 'b2'));
    await engine.publishEvent('ingested', { base: 'b1', v: 2 });
    await tick();
    expect(fired).toEqual([]);

    now += 6000;
    await engine.resumeDueTimers(now);
    await until(() => fired.length === 2);
    expect(fired).toEqual(
      expect.arrayContaining([
        { base: 'b1', v: 2 },
        { base: 'b2', v: 1 },
      ]),
    );
    expect(fired).toHaveLength(2);
    expect(await store.getRun('__evtacc__:refresh')).toBeNull();
  });

  it('batch: collects per key, firing the key that reaches maxSize only', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => 1000 });
    const fired: unknown[] = [];
    engine.register('agg', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['hit'],
      eventBatch: {
        mode: 'batch',
        maxSize: 2,
        windowMs: 60_000,
        key: (input) => (input as { k: string }).k,
      },
    });

    await engine.publishEvent('hit', { k: 'a', n: 1 });
    await engine.publishEvent('hit', { k: 'b', n: 1 });
    await engine.waitForRun(accumulatorRunId('agg', 'a'));
    await engine.waitForRun(accumulatorRunId('agg', 'b'));
    await engine.publishEvent('hit', { k: 'a', n: 2 });
    await until(() => fired.length > 0);
    await tick();
    expect(fired).toEqual([
      {
        events: [
          { k: 'a', n: 1 },
          { k: 'a', n: 2 },
        ],
      },
    ]);
  });

  it('keeps the unkeyed accumulator id, and escapes any key into a safe id', () => {
    expect(accumulatorRunId('refresh')).toBe('__evtacc__:refresh');
    expect(accumulatorRunId('refresh', 'base-1')).toBe('__evtacc__:refresh:base-1');
    expect(accumulatorRunId('refresh', 'a~2')).toBe('__evtacc__:refresh:a%7E2');
    expect(accumulatorRunId('refresh', 'x/y:z #1')).toBe('__evtacc__:refresh:x%2Fy%3Az%20%231');
  });
});

describe('onEvent debounce / batch with routed event ids', () => {
  type Routable = {
    accumulators: {
      route(target: string, config: unknown, payload: unknown, id?: string): Promise<unknown>;
    };
  };

  it('batch: an event routed twice under one id counts once, within and across bursts', async () => {
    const store = new InMemoryStateStore();
    const now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const fired: unknown[] = [];
    const config = { mode: 'batch', maxSize: 2, windowMs: 60_000 } as const;
    engine.register('agg', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['hit'],
      eventBatch: config,
    });
    const { accumulators } = engine as unknown as Routable;

    await accumulators.route('agg', config, { n: 1 }, 'src-1');
    await engine.waitForRun('__evtacc__:agg');
    await accumulators.route('agg', config, { n: 1 }, 'src-1');
    await accumulators.route('agg', config, { n: 2 }, 'src-2');
    await until(() => fired.length > 0);
    expect(fired).toEqual([{ events: [{ n: 1 }, { n: 2 }] }]);

    // The re-armed accumulator still knows both ids.
    await accumulators.route('agg', config, { n: 2 }, 'src-2');
    await accumulators.route('agg', config, { n: 3 }, 'src-3');
    await accumulators.route('agg', config, { n: 4 }, 'src-4');
    await until(() => fired.length > 1);
    expect(fired).toEqual([{ events: [{ n: 1 }, { n: 2 }] }, { events: [{ n: 3 }, { n: 4 }] }]);
  });

  it('debounce: a duplicate does not replace the last payload', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const fired: unknown[] = [];
    const config = { mode: 'debounce', windowMs: 5000 } as const;
    engine.register('handler', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['activity'],
      eventBatch: config,
    });
    const { accumulators } = engine as unknown as Routable;

    await accumulators.route('handler', config, { v: 1 }, 'a');
    await engine.waitForRun('__evtacc__:handler');
    await accumulators.route('handler', config, { v: 2 }, 'b');
    await accumulators.route('handler', config, { v: 1 }, 'a');
    await tick();
    now += 6000;
    await engine.resumeDueTimers(now);
    await until(() => fired.length > 0);
    expect(fired).toEqual([{ v: 2 }]);
  });
});
