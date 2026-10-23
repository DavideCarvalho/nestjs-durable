/**
 * Runs keyed tasks at most `limit` at a time; the rest wait in arrival order. A key already waiting
 * is not queued twice, so a burst of identical requests costs one entry. A task starts in a
 * microtask, like a bare `queueMicrotask`, as long as a slot is free.
 *
 * The engine runs in-process work through it (a started run's first turn, a deferred child start)
 * so a wide fan queues run ids instead of holding thousands of turns open at once.
 */
export class BoundedRunner {
  private active = 0;
  private readonly waiting = new Map<string, () => Promise<unknown>>();

  constructor(private readonly limit: number) {}

  /** Tasks running now plus tasks waiting for a slot. */
  get size(): number {
    return this.active + this.waiting.size;
  }

  submit(key: string, task: () => Promise<unknown>): void {
    if (this.active < this.limit) {
      this.active += 1;
      queueMicrotask(() => this.run(task));
      return;
    }
    if (!this.waiting.has(key)) this.waiting.set(key, task);
  }

  /** Forget every task still waiting for a slot. */
  clear(): void {
    this.waiting.clear();
  }

  private run(task: () => Promise<unknown>): void {
    let settled: Promise<unknown>;
    try {
      settled = task();
    } catch {
      settled = Promise.resolve();
    }
    void settled
      .catch(() => undefined)
      .then(() => {
        const next = this.waiting.entries().next();
        if (next.done) {
          this.active -= 1;
          return;
        }
        const [key, task] = next.value;
        this.waiting.delete(key);
        this.run(task);
      });
  }
}

/**
 * Most runs one instance executes at once when it picks them up itself: its in-process run starts,
 * the deferred starts of a fan's children, the runs announced to it as enqueued, and the runs it
 * consumes from a transport's run queue. A wide fan waits as run ids past it, so the instance holds
 * at most this many turns open regardless of the fan's width.
 */
export const LOCAL_RUN_CONCURRENCY = 256;
