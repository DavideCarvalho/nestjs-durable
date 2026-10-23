import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { StateStore } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function until(check: () => boolean | Promise<boolean>, max = 2_000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

const LEASE_MS = 30_000;
const RECONCILE_MS = 300_000;
const WAKES = 'durable:wake-after-turn:p';

/**
 * An instance's store, cut off once the instance has gone down (`kill()`, or its first call of
 * `trigger` after `arm()`): nothing it sends from then on answers, as the calls of a process that no
 * longer exists never land.
 */
function dying(
  inner: StateStore,
  trigger = 'tryLockRun',
): {
  store: StateStore;
  arm: () => void;
  kill: () => void;
  dead: () => boolean;
} {
  let armed = false;
  let dead = false;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (armed && prop === trigger) dead = true;
        return dead ? new Promise(() => {}) : value.apply(target, args);
      };
    },
  });
  return {
    store,
    arm: () => {
      armed = true;
    },
    kill: () => {
      dead = true;
    },
    dead: () => dead,
  };
}

/** Where the instance holding the run's lease goes down. */
const HOLDER_DIES = [
  {
    when: 'after deciding to run the turn a kept wake asks for, before running it',
    // The lease of that turn.
    trigger: 'tryLockRun',
  },
  {
    when: 'right after writing its suspension, before looking at the kept wake',
    // Releasing the lease, which comes before the look.
    trigger: 'releaseRunLock',
  },
];

describe.each(HOLDER_DIES)('a wake kept for a turn, the holder going down $when', ({ trigger }) => {
  it("is resumed on another instance's timer poll once the holder's lease is past", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const inner = new InMemoryStateStore();
    const holder = dying(inner, trigger);
    let turns = 0;
    let openTurn!: () => void;
    const held = new Promise<void>((resolve) => {
      openTurn = resolve;
    });
    const register = (engine: WorkflowEngine) =>
      engine.register('wf', '1', async (ctx) => {
        turns += 1;
        if (turns === 2) await held;
        await ctx.waitForSignal('go');
      });
    const a = new WorkflowEngine({
      store: holder.store,
      clock,
      leaseMs: LEASE_MS,
      reconcileMs: RECONCILE_MS,
    });
    const requester = dying(inner);
    const b = new WorkflowEngine({
      store: requester.store,
      clock,
      leaseMs: LEASE_MS,
      reconcileMs: RECONCILE_MS,
    });
    // A third instance, whose timer poll is all that is left once the other two are gone.
    const c = new WorkflowEngine({
      store: inner,
      clock,
      leaseMs: LEASE_MS,
      reconcileMs: RECONCILE_MS,
    });
    register(a);
    register(b);
    register(c);

    await a.start('wf', {}, 'p');
    await until(async () => (await inner.getRun('p'))?.status === 'suspended');
    // The holder's turn runs; a wake for the run lands on the other instance meanwhile.
    void a.resume('p');
    await until(() => turns === 2);
    await b.resume('p');
    // The other instance keeps its wake and sets the run's timer, then goes down too.
    await until(async () => {
      const run = await inner.getRun('p');
      return run?.wakeAt !== undefined && run.wakeAt <= now + LEASE_MS + 1_000;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    requester.kill();
    holder.arm();
    openTurn();
    await until(holder.dead);
    expect(turns).toBe(2);

    // Past the holder's lease, well short of the run's reconcile wake.
    now += LEASE_MS + 1_000;
    await c.resumeDueTimers(now);
    await until(() => turns === 3);
    await until(async () => (await inner.listBufferedEvents(WAKES, 10)).length === 0);
    expect((await inner.getRun('p'))?.status).toBe('suspended');
    expect(turns).toBe(3);
  });
});
