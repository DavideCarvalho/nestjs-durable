import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, RemoteTask, StepResult, Transport } from './interfaces';
import { DURABLE_STEP_NAME, type StepRef } from './step-name-symbol';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const STEP = 'Lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as unknown as { [DURABLE_STEP_NAME]: string })[DURABLE_STEP_NAME] = STEP;

/** Runs every dispatched step at once and hands its result straight back. */
class EchoTransport implements Transport {
  private handler?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.run(task);
  }
  async dispatchMany(tasks: RemoteTask[]): Promise<void> {
    for (const task of tasks) this.run(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.handler = handler;
  }
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  private run(task: RemoteTask): void {
    const i = (task.input as { i: number }).i;
    setImmediate(() => {
      void this.handler?.({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output: i,
      });
    });
  }
}

/** A Map that counts the entries every `for…of` over it visits. */
class CountingMap<K, V> extends Map<K, V> {
  visited = 0;
  override *[Symbol.iterator](): MapIterator<[K, V]> {
    for (const entry of super.entries()) {
      this.visited += 1;
      yield entry;
    }
  }
}

interface RecentMaps {
  settledHere: CountingMap<string, number>;
  stepFansFiredHere: CountingMap<string, number>;
  noteRecent(map: Map<string, number>, key: string): void;
}

function recentMaps(engine: WorkflowEngine): RecentMaps {
  const maps = engine as unknown as RecentMaps;
  maps.settledHere = new CountingMap();
  maps.stepFansFiredHere = new CountingMap();
  return maps;
}

async function settled(store: InMemoryStateStore, runId: string): Promise<string | undefined> {
  for (let i = 0; i < 2000; i += 1) {
    const status = (await store.getRun(runId))?.status;
    if (status === 'completed' || status === 'failed') return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return (await store.getRun(runId))?.status;
}

describe('the "settled here" maps', () => {
  it('a wide step fan settles without walking them once per result', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new EchoTransport(), reconcileMs: 0 });
    const maps = recentMaps(engine);
    const width = 3000;
    engine.register('fan', '1', async (ctx) => {
      const out = await ctx.all(
        processLine,
        Array.from({ length: width }, (_, i) => ({ i })),
      );
      return out.length;
    });
    await engine.start('fan', {}, 'f1');
    expect(await settled(store, 'f1')).toBe('completed');
    // The fan's own barrier re-drives it, so its steps are not remembered one by one.
    expect(maps.settledHere.size).toBe(0);
    expect(maps.settledHere.visited + maps.stepFansFiredHere.visited).toBeLessThan(width);
  });

  it('a plain step is remembered until it is older than a lease', async () => {
    let now = 1_000_000;
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      leaseMs: 1_000,
      clock: () => now,
    });
    const maps = recentMaps(engine);
    for (let k = 0; k < 2000; k += 1) {
      maps.noteRecent(maps.settledHere, `old:${k}`);
      now += 1;
    }
    expect(maps.settledHere.size).toBe(1001); // the ones within a lease of the latest
    maps.settledHere.visited = 0;
    now += 3;
    maps.noteRecent(maps.settledHere, 'fresh');
    // The four that went stale are dropped, and pruning stops at the first entry still fresh.
    expect(maps.settledHere.has('old:1002')).toBe(false);
    expect(maps.settledHere.has('old:1003')).toBe(true);
    expect(maps.settledHere.visited).toBe(5);
  });

  it('noting a key again moves it behind the fresher ones', () => {
    let now = 0;
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      leaseMs: 100,
      clock: () => now,
    });
    const maps = recentMaps(engine);
    maps.noteRecent(maps.settledHere, 'a');
    now = 50;
    maps.noteRecent(maps.settledHere, 'b');
    now = 90;
    maps.noteRecent(maps.settledHere, 'a');
    now = 160;
    maps.noteRecent(maps.settledHere, 'c');
    // `b` (noted at 50) is stale; `a` was noted again at 90 and is not.
    expect([...maps.settledHere.keys()]).toEqual(['a', 'c']);
  });
});

describe("a step fan's checkpoints", () => {
  it('the turn that joins the fan does not read its settled checkpoints twice', async () => {
    const inner = new InMemoryStateStore();
    const reads: string[] = [];
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (prop === 'listCheckpoints') reads.push('list');
          if (prop === 'listCheckpointsForReplay') reads.push('replay');
          if (prop === 'getCheckpoints') reads.push(`get:${(args[1] as number[]).length}`);
          return value.apply(target, args);
        };
      },
    });
    const engine = new WorkflowEngine({ store, transport: new EchoTransport(), reconcileMs: 0 });
    let turns = 0;
    engine.register('fan', '1', async (ctx) => {
      turns += 1;
      const out = await ctx.all(
        processLine,
        Array.from({ length: 500 }, (_, i) => ({ i })),
      );
      return out.reduce((a, b) => a + b, 0);
    });
    await engine.start('fan', {}, 'f2');
    expect(await settled(inner, 'f2')).toBe('completed');
    expect((await inner.getRun('f2'))?.output).toBe((499 * 500) / 2);
    expect(turns).toBe(2);
    // Turn 1: its snapshot, then the fan's own read (nothing was sent yet). Turn 2: its snapshot
    // only, which already holds every step settled.
    expect(reads.filter((r) => r === 'list' || r === 'replay')).toEqual([
      'replay',
      'list',
      'replay',
    ]);
  });
});
