import type { SingletonConfig } from './engine';
import { SingletonQueueFullError } from './errors';
import type { StateStore, WorkflowRun } from './interfaces';
import {
  SINGLETON_ACTIVE_STATUSES,
  SINGLETON_ADMITTED_TAG,
  SINGLETON_TRACKED_TAG,
  withSingletonTracked,
} from './singleton-admission';

const SINGLETON_RETRY_MS = 1000;
/**
 * Max jitter (ms, each direction) added to {@link SINGLETON_RETRY_MS} so a queue of N gated runs
 * doesn't wake in lockstep and stampede the admission scan. Each retry picks an independent offset
 * in `[-SINGLETON_RETRY_JITTER_MS, +SINGLETON_RETRY_JITTER_MS]`.
 */
const SINGLETON_RETRY_JITTER_MS = 250;
/** Claims a database may abort as a lock conflict before the run waits for its retry timer instead. */
const ADMISSION_ATTEMPTS = 3;
const ADMISSION_BACKOFF_MS = 40;

/** Deadlock and serialization failure on Postgres and MySQL, and Prisma's name for either. */
const LOCK_CONFLICT_CODES = new Set(['40P01', '40001', 'ER_LOCK_DEADLOCK', '1213', 'P2034']);

/** Whether a store error, through any driver or ORM wrapper around it, is an aborted lock conflict. */
export function isLockConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    const e = current as Record<string, unknown>;
    for (const code of [e.code, e.errno, e.sqlState, e.sqlstate]) {
      if (LOCK_CONFLICT_CODES.has(String(code))) return true;
    }
    pending.push(e.cause, e.driverError, e.originalError, e.meta);
  }
  return false;
}

export interface SingletonGateDeps {
  store: Pick<StateStore, 'listRuns' | 'updateRun' | 'updateRunIf' | 'tryAdmitSingleton'>;
  clock: () => number;
  /** Hand a gated run to the run dispatcher (fire-and-forget, like the engine's other dispatches). */
  dispatch: (runId: string) => void;
  /** Resolve a settled run's singleton config from the engine's workflow registry. */
  configFor: (run: WorkflowRun) => SingletonConfig | undefined;
}

/**
 * Per-key serialization for singleton workflows — start-time back-pressure, durable atomic
 * admission, and notify-on-release wakeups. Extracted from {@link WorkflowEngine} so the whole
 * singleton feature lives in one place instead of being smeared across `start`, `execute`, both run
 * loops, and `cancel`.
 */
export class SingletonGate {
  constructor(private readonly deps: SingletonGateDeps) {}

  /** The tag a singleton run carries, so the gate can find others sharing its key. */
  tag(cfg: SingletonConfig, input: unknown): string {
    if (!this.deps.store.tryAdmitSingleton) {
      throw new Error(
        'Singleton workflows require StateStore.tryAdmitSingleton for atomic durable admission',
      );
    }
    return `singleton:${cfg.key(input)}`;
  }

  /** Next wake time for a gated run: the base retry delay jittered to avoid a wakeup stampede. */
  retryWakeAt(): number {
    return (
      this.deps.clock() +
      SINGLETON_RETRY_MS +
      Math.floor((Math.random() * 2 - 1) * SINGLETON_RETRY_JITTER_MS)
    );
  }

  /**
   * Reject a start that would grow the same-key backlog past `limit + maxQueueDepth` (counting
   * `pending`/`running`/`suspended`/`blocked`/`cancelling` runs sharing the key in one scan). No-op when no `maxQueueDepth`
   * is configured.
   */
  async assertCapacity(workflow: string, cfg: SingletonConfig, input: unknown): Promise<void> {
    if (cfg.maxQueueDepth == null) return;
    const cap = (cfg.limit ?? 1) + cfg.maxQueueDepth;
    const queued = await this.deps.store.listRuns({
      tag: this.tag(cfg, input),
      workflow,
      statuses: SINGLETON_ACTIVE_STATUSES,
    });
    if (queued.length >= cap) {
      throw new SingletonQueueFullError(workflow, cfg.key(input), cfg.maxQueueDepth);
    }
  }

  /** Preserve durable holders and atomically claim one of the remaining slots. */
  async admit(run: WorkflowRun, cfg: SingletonConfig): Promise<boolean> {
    if (!this.deps.store.tryAdmitSingleton) {
      throw new Error(
        'Singleton workflows require StateStore.tryAdmitSingleton for atomic durable admission',
      );
    }
    const admitted = await this.claim(run, cfg);
    if (admitted && !run.tags?.includes(SINGLETON_ADMITTED_TAG)) {
      run.tags = [
        ...(run.tags ?? []).filter((tag) => tag !== SINGLETON_TRACKED_TAG),
        SINGLETON_ADMITTED_TAG,
      ];
    }
    return admitted;
  }

  /**
   * One claim, retried when the database aborts it as a lock conflict. A conflict that outlasts the
   * retries parks the run on its retry timer: thrown, it would leave the run leased and idle until
   * the lease lapsed.
   */
  private async claim(run: WorkflowRun, cfg: SingletonConfig): Promise<boolean> {
    const admit = this.deps.store.tryAdmitSingleton as NonNullable<StateStore['tryAdmitSingleton']>;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await admit.call(
          this.deps.store,
          run.id,
          this.tag(cfg, run.input),
          run.workflow,
          cfg.limit ?? 1,
          this.retryWakeAt(),
        );
      } catch (error) {
        if (!isLockConflict(error)) throw error;
        if (attempt < ADMISSION_ATTEMPTS) {
          const backoff = ADMISSION_BACKOFF_MS * attempt * (0.5 + Math.random());
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        // Only a run still competing: a cancelling or settled one must never be revived.
        const patch = {
          status: 'suspended' as const,
          wakeAt: this.retryWakeAt(),
          tags: withSingletonTracked(run.tags),
          updatedAt: new Date(),
        };
        if (this.deps.store.updateRunIf) {
          await this.deps.store.updateRunIf(
            run.id,
            ['pending', 'running', 'suspended', 'blocked'],
            patch,
          );
        } else if (run.status !== 'cancelling') {
          await this.deps.store.updateRun(run.id, patch);
        }
        return false;
      }
    }
  }

  /**
   * Notify-on-release: a singleton run settled (freeing a slot), so dispatch the oldest gated
   * (`suspended` + same tag) waiters now instead of waiting for their ~1s retry timer. Each re-checks
   * admission in the executor and runs only if it actually wins a slot, so FIFO/race-free guarantees
   * hold; the durable timer remains the cross-instance/crash fallback.
   */
  async wakeNext(settled: WorkflowRun): Promise<void> {
    const cfg = this.deps.configFor(settled);
    if (!cfg) return;
    const tag = settled.tags?.find((t) => t.startsWith('singleton:'));
    if (!tag) return;
    const gated = (
      await this.deps.store.listRuns({ tag, workflow: settled.workflow, statuses: ['suspended'] })
    ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    for (const next of gated.slice(0, cfg.limit ?? 1)) {
      // Stamp a due-NOW wakeAt as the run is handed over. `dispatch` goes through the configured
      // `runDispatcher`, which may legitimately be a NO-OP (an API/dashboard pod that must not run
      // workflows still settles runs it observes, so it still lands here), which makes the durable
      // timer the only guaranteed pickup: a `suspended` run carrying no `wakeAt` is invisible to
      // every poll path — `listPendingRuns`, `listIncompleteRuns` and `listDueTimers` alike — and
      // never resumes. A dispatch + timer double-drive is safe: the run lock admits one executor and
      // the loser's pickup is a cheap no-op.
      await this.deps.store
        .updateRun(next.id, { wakeAt: this.deps.clock(), updatedAt: new Date() })
        .catch(() => undefined);
      this.deps.dispatch(next.id);
    }
  }
}
