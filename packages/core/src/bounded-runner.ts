/**
 * Runs keyed tasks at most `limit` at a time; the rest wait in arrival order. A key already waiting
 * is not queued twice, so a burst of identical requests costs one entry. A task starts in a
 * microtask, like a bare `queueMicrotask`, as long as a slot is free.
 *
 * The engine runs all of its in-process work through one of these (a started run's turn, a
 * deferred child start, an enqueued pickup, a run taken off the transport's queue), so a wide fan
 * queues run ids instead of holding thousands of turns open at once.
 */
export class BoundedRunner {
  private active = 0;
  private readonly waiting = new Map<string, Waiting>();
  private seq = 0;

  constructor(private readonly limit: number) {}

  /** Tasks running now plus tasks waiting for a slot. */
  get size(): number {
    return this.active + this.waiting.size;
  }

  /** Tasks running now. */
  get running(): number {
    return this.active;
  }

  submit(key: string, task: () => Promise<unknown>): void {
    if (this.active < this.limit) {
      this.active += 1;
      queueMicrotask(() => this.execute(task));
      return;
    }
    if (!this.waiting.has(key)) this.waiting.set(key, { task });
  }

  /**
   * Run `task` under the bound and resolve once it settled, or once it was dropped by
   * {@link clear} before it got a slot. Never deduplicated.
   */
  run(task: () => Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => resolve();
      const wrapped = () => task().then(done, done);
      if (this.active < this.limit) {
        this.active += 1;
        queueMicrotask(() => this.execute(wrapped));
        return;
      }
      this.seq += 1;
      this.waiting.set(`\u0000run:${this.seq}`, { task: wrapped, dropped: done });
    });
  }

  /** Forget every task still waiting for a slot. */
  clear(): void {
    for (const { dropped } of this.waiting.values()) dropped?.();
    this.waiting.clear();
  }

  private execute(task: () => Promise<unknown>): void {
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
        const [key, waiting] = next.value;
        this.waiting.delete(key);
        this.execute(waiting.task);
      });
  }
}

interface Waiting {
  task: () => Promise<unknown>;
  /** Resolves the caller of {@link BoundedRunner.run} when the task is dropped unrun. */
  dropped?: () => void;
}

/**
 * Most runs one instance executes at once when it picks them up itself: its in-process run starts,
 * the deferred starts of a fan's children, the runs announced to it as enqueued, and the runs it
 * consumes from a transport's run queue. A wide fan waits as run ids past it, so the instance holds
 * at most this many turns open regardless of the fan's width.
 */
export const LOCAL_RUN_CONCURRENCY = 256;
