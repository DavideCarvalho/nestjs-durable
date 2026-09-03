import {
  DURABLE_OPTIONS_CANONICAL,
  STATE_STORE_CANONICAL,
  type StateStore,
  TERMINAL_RUN_STATUSES,
  parseDuration,
} from '@dudousxd/nestjs-durable-core';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { DurableModuleOptions, DurableRetentionOptions } from './durable.module';
import { isDrivingOperator } from './role';

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 1_000;
// Backstop so a single sweep can never loop unbounded. At the default batch size this still drains up
// to 100k runs per policy per sweep before yielding the event loop to the next tick.
const MAX_BATCHES_PER_POLICY = 100;

/**
 * Reject a retention config that would silently misbehave: every policy must set at least one bound,
 * list only terminal statuses (pruning a live status would race the engine), and the status sets must
 * be disjoint (so "most recent N" is unambiguous per status group). Throws on the first violation.
 */
export function validateRetention(retention: DurableRetentionOptions): void {
  const seen = new Set<string>();
  for (const policy of retention.policies) {
    if (policy.statuses.length === 0) {
      throw new Error('durable retention: each policy must list at least one status');
    }
    if (policy.maxAge == null && policy.maxCount == null) {
      throw new Error('durable retention: each policy must set maxAge and/or maxCount');
    }
    // Fail fast on a typo'd duration string ('7days', '1 month') at boot rather than silently never pruning.
    if (policy.maxAge != null) parseDuration(policy.maxAge);
    for (const status of policy.statuses) {
      if (!TERMINAL_RUN_STATUSES.includes(status)) {
        throw new Error(
          `durable retention: status "${status}" is not terminal; only ${TERMINAL_RUN_STATUSES.join(
            ', ',
          )} can be pruned`,
        );
      }
      if (seen.has(status)) {
        throw new Error(
          `durable retention: status "${status}" appears in more than one policy; status sets must be disjoint`,
        );
      }
      seen.add(status);
    }
  }
}

/**
 * Hard-prunes terminal run history on an interval per the configured `retention` policies, keeping the
 * `durable_workflow_runs` table (and its children) bounded so the poller's per-tick scans stay cheap.
 *
 * Worker-only (a dashboard-only instance never prunes), separate from the 1s timer poll (defaults to a
 * 60s sweep), and self-draining: each policy is swept in `batchSize` chunks until a batch comes back
 * short. No-ops with a warning if the store adapter doesn't implement `pruneTerminalRuns`.
 */
@Injectable()
export class RetentionPoller implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    @Inject(STATE_STORE_CANONICAL) private readonly store: StateStore | null,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
  ) {}

  /** Non-null once past the `isDrivingOperator` guard (which requires `options.store` to be set). */
  private requireStore(): StateStore {
    if (!this.store) {
      throw new Error(
        'unreachable: STATE_STORE_CANONICAL must resolve a store when options.store is set',
      );
    }
    return this.store;
  }

  async onApplicationBootstrap(): Promise<void> {
    // Only a DRIVING operator prunes — a dashboard/dispatch-only instance, or a thin worker with no
    // `store` at all, must not delete history.
    if (!isDrivingOperator(this.options)) return;
    const retention = this.options.retention;
    if (!retention || retention.policies.length === 0) return;
    validateRetention(retention);
    if (typeof this.requireStore().pruneTerminalRuns !== 'function') {
      console.warn(
        '[nestjs-durable] `retention` is configured but the store adapter does not implement pruneTerminalRuns; retention is disabled.',
      );
      return;
    }
    await this.sweep();
    const intervalMs =
      retention.sweepInterval != null
        ? parseDuration(retention.sweepInterval)
        : DEFAULT_SWEEP_INTERVAL_MS;
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.sweep(), intervalMs);
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Prune one round.
   *
   * Never rejects, for the same reason {@link TimerPoller.poll} does not: it is awaited inside
   * `onApplicationBootstrap` (so a rejection propagates into the host's `bootstrap()` and kills the
   * process) and fired as `void` on the interval (so a rejection is an unhandled one, also fatal).
   * Pruning history is the least urgent thing this package does — a `pruneTerminalRuns` that fails
   * on a locked table must cost this sweep and nothing more.
   */
  private async sweep(): Promise<void> {
    if (this.sweeping) return; // never overlap two sweeps on this instance
    const retention = this.options.retention;
    const store = this.requireStore();
    const prune = store.pruneTerminalRuns;
    if (!retention || typeof prune !== 'function') return;
    this.sweeping = true;
    try {
      const batchSize = retention.batchSize ?? DEFAULT_BATCH_SIZE;
      const now = Date.now();
      for (const policy of retention.policies) {
        for (let batch = 0; batch < MAX_BATCHES_PER_POLICY; batch++) {
          const deleted = await prune.call(store, policy, now, batchSize);
          if (deleted < batchSize) break; // backlog drained for this policy
        }
      }
    } catch (error) {
      console.error('[nestjs-durable] retention sweep failed; retrying next interval:', error);
    } finally {
      this.sweeping = false;
    }
  }
}
