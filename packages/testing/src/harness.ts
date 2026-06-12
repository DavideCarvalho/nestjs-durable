import {
  InMemoryStateStore,
  InMemoryTransport,
  type RunResult,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';

/** A clock you control, for testing durable sleeps without real time. */
export class MutableClock {
  constructor(private current = 1_000) {}
  readonly now = (): number => this.current;
  set(ms: number): void {
    this.current = ms;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export interface TestEngine {
  engine: WorkflowEngine;
  store: InMemoryStateStore;
  transport: InMemoryTransport;
  clock: MutableClock;
  /** Advance the clock by `ms` and resume any durable sleeps now due. */
  tick(ms: number): Promise<RunResult[]>;
}

/**
 * A self-contained engine wired to in-memory store + transport and a controllable clock — run a
 * whole workflow in a unit test, with no Postgres, no Redis, and no real time.
 */
export function createTestEngine(): TestEngine {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const clock = new MutableClock();
  const engine = new WorkflowEngine({ store, transport, clock: clock.now });
  return {
    engine,
    store,
    transport,
    clock,
    async tick(ms: number): Promise<RunResult[]> {
      clock.advance(ms);
      return engine.resumeDueTimers(clock.now());
    },
  };
}
