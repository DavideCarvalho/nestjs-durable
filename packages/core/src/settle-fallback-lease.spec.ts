import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type {
  HistoryEvent,
  StateStore,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
} from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

// On a store without `settleCheckpointsIfPending` / `settleResultsIfPending`, the engine settles a
// step's result by writing the whole row while it is still `pending`. That fallback clears the
// dispatch lease too, so a failed dispatched step with a retry policy waits its backoff, not the
// lost-dispatch lease (`remoteRedispatchMs`) it was dispatched with.

const REDISPATCH_MS = 600_000;
const POLICY = { retries: 3, backoff: 'fixed' as const, backoffMs: 1_000 };

/** The store without its settle methods: the engine takes its whole-row fallback. */
function withoutSettle(inner: InMemoryStateStore): StateStore {
  const hidden = new Set(['settleCheckpointsIfPending', 'settleResultsIfPending']);
  return new Proxy(inner, {
    get(target, key) {
      if (typeof key === 'string' && hidden.has(key)) return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as StateStore;
}

/** A dispatched workflow's turns, as a worker replays `ctx.step('ext.flaky', {}, POLICY)`. */
function flakyStepExecutor(): WorkflowExecutor {
  return {
    async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
      const base = { taskId: `${run.id}:t`, runId: run.id };
      const ev = history.find((e) => e.seq === 0);
      if (ev && ev.error == null) {
        return { ...base, status: 'completed', commands: [], output: ev.output };
      }
      if (ev?.error && (ev.attempts ?? 1) >= POLICY.retries) {
        return { ...base, status: 'failed', commands: [], error: ev.error };
      }
      return {
        ...base,
        status: 'continue',
        commands: [
          { kind: 'call', seq: 0, name: 'ext.flaky', group: 'ext', input: {}, policy: POLICY },
        ],
      };
    },
  };
}

async function ticks(n = 30): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

describe('settling a step result on a store without the settle methods', () => {
  it('clears the dispatch lease, so a failed attempt is retried after its backoff', async () => {
    let now = 1_000_000;
    const inner = new InMemoryStateStore();
    const store = withoutSettle(inner);
    expect(store.settleCheckpointsIfPending).toBeUndefined();
    const transport = new InMemoryTransport();
    let attempts = 0;
    transport.handle('ext.flaky', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`wedged ${attempts}`);
      return 'ok';
    });
    const engine = new WorkflowEngine({
      store,
      transport,
      clock: () => now,
      remoteRedispatchMs: REDISPATCH_MS,
    });
    engine.registerRemote('wf', '1', { group: 'wf', executor: flakyStepExecutor() });

    const startedAt = now;
    await engine.start('wf', {}, 'r1');
    await ticks();
    // The first attempt failed: the lease it was dispatched with is gone, its backoff stamped.
    const failed = await inner.getCheckpoint('r1', 0);
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(1);
    expect(failed?.wakeAt).toBeDefined();
    expect(failed?.wakeAt).toBeLessThan(startedAt + 10_000);

    // 5 s at a time, 20 times: well short of the 600 s lease.
    for (let i = 0; i < 20; i += 1) {
      const run = await inner.getRun('r1');
      if (run?.status === 'completed' || run?.status === 'failed') break;
      now += 5_000;
      await engine.resumeDueTimers(now);
      await ticks();
    }
    const run = await inner.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('ok');
    expect(attempts).toBe(3);
    expect((await inner.getCheckpoint('r1', 0))?.attempts).toBe(3);
    expect(now).toBeLessThan(startedAt + REDISPATCH_MS);
  });
});
