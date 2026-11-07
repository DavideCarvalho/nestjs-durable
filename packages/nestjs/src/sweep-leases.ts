import { DURABLE_OPTIONS_CANONICAL } from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { DurableModuleOptions } from './durable.module';

/**
 * The slice of `@nestjs/locks` used here, structurally: the package is an OPTIONAL peer, so nothing
 * from it is imported statically (the main entry must load without it).
 */
interface HeldLock {
  readonly held: boolean;
}
interface LocksLike {
  acquire(
    key: string,
    options?: { ttl?: number | string; wait?: number | string },
  ): Promise<HeldLock | null>;
}

/** The fleet-wide sweeps gated by a lease when `@nestjs/locks` is present. */
export type FleetSweep = 'retention' | 'stalled-pager' | 'buffered-signals';

/**
 * Runs durable's FLEET-WIDE sweeps (retention pruning, the stalled-run pager, the orphaned
 * buffered-signal cleanup) on one pod at a time when the app imports `LocksModule` from
 * `@nestjs/locks`. Detected, never configured: with no `Locks` provider in the app, every sweep runs
 * on every driving pod exactly as before.
 *
 * Each sweep holds its own lease, `durable:<sweep>` (suffixed `:<namespace>` on a namespaced engine).
 * The first pod to tick takes it and KEEPS it (the official `Lock` renews itself every `ttl / 3`);
 * the others skip that sweep on every tick until the holder stops renewing (crash, shutdown, a lost
 * lease), and the next tick elsewhere takes over. A lease held across ticks, rather than a lock per
 * tick, is what keeps the pager from paging once per pod: pods tick at different moments, so a lock
 * released after each tick would be won by each pod in turn.
 *
 * The leases go back at shutdown with every other lock (`Locks.beforeApplicationShutdown`, after
 * the pollers have waited for their sweep in `onModuleDestroy`).
 *
 * Work-claiming sweeps (pending runs, recovery, timers, timeouts, schedules, lifecycle events) stay
 * on every pod: they already arbitrate per run with leases / compare-and-set.
 */
@Injectable()
export class SweepLeases implements OnModuleInit {
  private readonly logger = new Logger('nestjs-durable');
  /** Set by {@link onModuleInit} (before any poller's bootstrap). `null`: no `@nestjs/locks`. */
  private locks: LocksLike | null = null;
  private readonly leases = new Map<FleetSweep, HeldLock>();

  constructor(
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional()
    @Inject(DURABLE_OPTIONS_CANONICAL)
    private readonly options?: DurableModuleOptions,
  ) {}

  /**
   * Run `fn` if this pod holds (or now takes) the lease of `sweep`; otherwise skip it and resolve
   * `undefined`. Without `@nestjs/locks` it always runs `fn`.
   */
  async run<T>(sweep: FleetSweep, fn: () => Promise<T>): Promise<T | undefined> {
    const locks = this.locks;
    // No `@nestjs/locks`: straight through, with no extra await (today's timing, unchanged).
    if (!locks) return fn();
    if (!(await this.holds(locks, sweep))) return undefined;
    return fn();
  }

  private async holds(locks: LocksLike, sweep: FleetSweep): Promise<boolean> {
    if (this.leases.get(sweep)?.held) return true;
    this.leases.delete(sweep);
    let lock: HeldLock | null;
    try {
      lock = await locks.acquire(this.key(sweep));
    } catch (error) {
      // A lock store that fails or times out costs this tick of this sweep, nothing more.
      this.logger.warn(
        `could not take the ${sweep} sweep lease; skipping this tick: ${String(error)}`,
      );
      return false;
    }
    if (!lock) return false;
    this.leases.set(sweep, lock);
    return true;
  }

  private key(sweep: FleetSweep): string {
    const ns = this.options?.namespace;
    return ns ? `durable:${sweep}:${ns}` : `durable:${sweep}`;
  }

  /** Detects `Locks` once, and logs which mode is active. Nest awaits it before any bootstrap hook. */
  async onModuleInit(): Promise<void> {
    this.locks = await this.detect();
    this.logger.log(
      this.locks
        ? 'fleet-wide sweeps (retention, stalled-run pager, buffered-signal cleanup) run on one pod at a time, through @nestjs/locks'
        : 'fleet-wide sweeps run on every driving pod (import LocksModule from @nestjs/locks to run them on one)',
    );
  }

  private async detect(): Promise<LocksLike | null> {
    let locks: LocksLike | null = null;
    if (this.moduleRef) {
      try {
        // Indirect specifier: the optional peer must not be resolved statically by the compiler or
        // the bundler. A missing package rejects and lands in the catch.
        const specifier = '@nestjs/locks';
        const mod = (await import(specifier)) as {
          Locks?: abstract new (...args: never[]) => unknown;
        };
        if (mod.Locks) {
          locks = this.moduleRef.get(mod.Locks, { strict: false }) as unknown as LocksLike;
        }
      } catch {
        locks = null;
      }
    }
    return locks;
  }
}
