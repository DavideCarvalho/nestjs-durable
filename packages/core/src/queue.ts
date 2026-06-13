/**
 * Flow control for remote steps. A queue caps how much work `ctx.call(step, input, { queue })`
 * admits at once — a concurrency limit and/or a fixed-window rate limit. When a call can't be
 * admitted it doesn't dispatch: the run re-suspends with a near-future wake time, and the timer
 * poller re-tries admission later — so flow control is durable (survives crashes) without holding
 * the run in memory.
 *
 * Accounting is per engine instance (the DBOS `workerConcurrency` tier): correct for the common
 * single-orchestrator deployment. Global, cross-instance limits would need a durable counter in the
 * store — a deliberate follow-up, not built here.
 */
export interface QueueConfig {
  /** Queue name, referenced by `ctx.call(step, input, { queue: name })`. */
  name: string;
  /** Max steps in flight at once for this queue (this instance). Omit for unlimited. */
  concurrency?: number;
  /** Fixed-window rate limit: at most `limit` admissions per `periodMs`. Omit for unlimited. */
  rateLimit?: { limit: number; periodMs: number };
  /** Delay (ms) before a concurrency-blocked call re-checks for a free slot. Default 1000. */
  retryMs?: number;
}

/** Admission decision: either admitted, or blocked until `retryAt` (epoch ms). */
export type Admission = { ok: true } | { ok: false; retryAt: number };

/** In-process admission controller for one {@link QueueConfig}. */
export class QueueController {
  private inFlight = 0;
  private windowStart = 0;
  private windowCount = 0;

  constructor(
    readonly config: QueueConfig,
    private readonly clock: () => number,
  ) {}

  /**
   * Try to admit one unit of work. On `ok`, the caller has taken a concurrency slot and must call
   * {@link release} when the step settles. On block, `retryAt` is when admission may next succeed.
   */
  tryAdmit(): Admission {
    const now = this.clock();
    const rl = this.config.rateLimit;
    if (rl) {
      if (now - this.windowStart >= rl.periodMs) {
        this.windowStart = now;
        this.windowCount = 0;
      }
      if (this.windowCount >= rl.limit) return { ok: false, retryAt: this.windowStart + rl.periodMs };
    }
    if (this.config.concurrency != null && this.inFlight >= this.config.concurrency) {
      return { ok: false, retryAt: now + (this.config.retryMs ?? 1000) };
    }
    if (rl) this.windowCount += 1;
    this.inFlight += 1;
    return { ok: true };
  }

  /** Release a concurrency slot taken by a successful {@link tryAdmit}. */
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }
}
