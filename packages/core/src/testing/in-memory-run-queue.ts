import type {
  Heartbeat,
  RemoteTask,
  RunConsumerOptions,
  RunDispatch,
  RunQueueOptions,
  StepResult,
  Transport,
} from '../interfaces';

interface Consumer {
  handler: (run: RunDispatch) => Promise<void>;
  concurrency: number;
  active: number;
  stopped: boolean;
  idle: (() => void)[];
}

interface Lane {
  waiting: RunDispatch[];
  /** The waiting entry of each run, so a repeat merges into it. */
  queued: Map<string, RunDispatch>;
  consumers: Consumer[];
  next: number;
}

/**
 * An in-process run queue shared by several {@link Transport}s, for tests: each
 * {@link InMemoryRunQueue.transport} is one instance of a deployment, and a run queued by any of
 * them goes to whichever consumer has a free slot, round-robin. A run waiting in the queue is not
 * queued twice (a wake turns a waiting start into a wake); one being handled is queued again.
 * Higher priority goes first. The transports carry no remote steps.
 */
export class InMemoryRunQueue {
  private readonly lanes = new Map<string, Lane>();

  /** A transport on this queue. */
  transport(): Transport {
    return {
      dispatch: async (_task: RemoteTask) => {
        throw new Error('InMemoryRunQueue carries no remote steps');
      },
      onResult: (_handler: (result: StepResult) => Promise<void>) => {},
      onHeartbeat: (_handler: (beat: Heartbeat) => Promise<void>) => {},
      dispatchRuns: async (runs, opts) => this.add(runs, opts),
      onDispatchedRun: (handler, opts) => this.consume(handler, opts),
    };
  }

  /** Runs waiting in the queue of `namespace`. */
  waiting(namespace?: string): string[] {
    return (this.lanes.get(namespace ?? '')?.waiting ?? []).map((r) => r.runId);
  }

  private lane(namespace: string | undefined): Lane {
    const key = namespace ?? '';
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { waiting: [], queued: new Map(), consumers: [], next: 0 };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  private add(runs: readonly RunDispatch[], opts?: RunQueueOptions): void {
    const lane = this.lane(opts?.namespace);
    for (const run of runs) {
      const waiting = lane.queued.get(run.runId);
      if (waiting) {
        // A wake for a waiting start makes it a wake: a wake also runs a `pending` run.
        if (run.reason === 'wake') waiting.reason = 'wake';
        continue;
      }
      const entry = { ...run };
      lane.queued.set(run.runId, entry);
      lane.waiting.push(entry);
    }
    lane.waiting.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    setImmediate(() => this.pump(lane));
  }

  private consume(
    handler: (run: RunDispatch) => Promise<void>,
    opts: RunConsumerOptions,
  ): () => Promise<void> {
    const lane = this.lane(opts.namespace);
    const consumer: Consumer = {
      handler,
      concurrency: Math.max(1, opts.concurrency),
      active: 0,
      stopped: false,
      idle: [],
    };
    lane.consumers.push(consumer);
    setImmediate(() => this.pump(lane));
    return () => {
      consumer.stopped = true;
      lane.consumers = lane.consumers.filter((c) => c !== consumer);
      if (consumer.active === 0) return Promise.resolve();
      return new Promise<void>((resolve) => consumer.idle.push(resolve));
    };
  }

  private pump(lane: Lane): void {
    while (lane.waiting.length > 0) {
      const free = lane.consumers.filter((c) => !c.stopped && c.active < c.concurrency);
      if (free.length === 0) return;
      const consumer = free[lane.next % free.length] as Consumer;
      lane.next += 1;
      const run = lane.waiting.shift() as RunDispatch;
      lane.queued.delete(run.runId);
      consumer.active += 1;
      void consumer
        .handler(run)
        .catch(() => undefined)
        .then(() => {
          consumer.active -= 1;
          if (consumer.active === 0 && consumer.stopped) {
            for (const resolve of consumer.idle.splice(0)) resolve();
          }
          this.pump(lane);
        });
    }
  }
}
