import type { RunDispatch } from './interfaces';

/** Most runs one {@link RunDispatchBatcher} send carries. */
export const RUN_DISPATCH_BATCH = 500;
/** How long a batch waits for more runs before it is sent. */
export const RUN_DISPATCH_WINDOW_MS = 5;

/**
 * Collects the runs an engine dispatches over a transport's run queue and sends them in batches of
 * at most {@link RUN_DISPATCH_BATCH}: a batch goes out once it is full, or
 * {@link RUN_DISPATCH_WINDOW_MS} after its first run. A fan's children, started a few hundred at a
 * time, reach the broker as a handful of bulk writes instead of one round trip each.
 *
 * A failed send is reported to `onError` and not retried: a start stays `pending` in the store for a
 * `runPending` poll, and the caller decides what a lost wake costs.
 */
export class RunDispatchBatcher {
  private buffer = new Map<string, RunDispatch>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly sending = new Set<Promise<void>>();

  constructor(
    private readonly send: (runs: RunDispatch[]) => Promise<void>,
    private readonly onError: (runs: RunDispatch[], err: unknown) => void,
  ) {}

  /** Nothing buffered and nothing being sent. */
  get idle(): boolean {
    return this.buffer.size === 0 && this.sending.size === 0;
  }

  /** Buffer `run`. A wake for a run already buffered replaces its start: a wake also runs a `pending` run. */
  add(run: RunDispatch): void {
    const prior = this.buffer.get(run.runId);
    if (prior && run.reason !== 'wake') return;
    this.buffer.set(run.runId, run);
    if (this.buffer.size >= RUN_DISPATCH_BATCH) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), RUN_DISPATCH_WINDOW_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Send what is buffered now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.buffer.size === 0) return;
    const runs = [...this.buffer.values()];
    this.buffer = new Map();
    const sent = this.send(runs)
      .catch((err) => this.onError(runs, err))
      .finally(() => this.sending.delete(sent));
    this.sending.add(sent);
  }

  /** Send what is buffered and wait for every send in flight. */
  async settle(): Promise<void> {
    this.flush();
    await Promise.allSettled([...this.sending]);
  }
}
