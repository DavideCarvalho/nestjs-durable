import * as durableCore from '@dudousxd/nestjs-durable-core';
import {
  ANNOUNCED_SCHEDULE_TAG,
  DURABLE_OPTIONS_CANONICAL,
  type ScheduledWorkflow,
  WorkflowEngine,
  runSchedules,
  workflowName,
} from '@dudousxd/nestjs-durable-core';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { DurableModuleOptions } from './durable.module';
import { isDrivingOperator } from './role';
import { settleWithin } from './settle-within';
import { SweepLeases } from './sweep-leases';

/** What {@link TimerPoller.sweep} resolves when the sweep threw. */
const SWEEP_FAILED = Symbol('sweep failed');

/**
 * The in-process schedules' next window (core `nextScheduleFireAt`), read off the module namespace
 * because an older core (the peer range is wide) does not export it; the poller then keeps the fixed
 * tick when `schedules` are configured.
 */
const nextScheduleFireAt = (
  durableCore as {
    nextScheduleFireAt?: (
      engine: object,
      schedules: readonly ScheduledWorkflow[],
      nowMs: number,
    ) => number | undefined;
  }
).nextScheduleFireAt;

/**
 * Resumes suspended runs whose durable timer (`ctx.sleep`) is due, and fires any configured
 * recurring `schedules` (plus the persisted `engine.schedules` when `persistedSchedules` is on) —
 * once on boot, then on an interval. Set `timerPollMs` to `0` to disable
 * the interval (e.g. when an external scheduler drives `WorkflowEngine.resumeDueTimers`).
 *
 * The boot poll is started, not awaited: `onApplicationBootstrap` runs before the host's HTTP server
 * listens, so a first poll held up by a large backlog would keep the pod from ever passing its
 * readiness probe. Shutdown still waits for whichever poll is in flight.
 *
 * While polls find nothing to do the wait between them backs off to `maxIdleIntervalMs` (default
 * 5 s), never past the next known due time and back to `timerPollMs` on any run event — see
 * {@link DurableModuleOptions.maxIdleIntervalMs}. The owed-lifecycle listing runs once per
 * `owedLifecycleSweepMs` (default 10 s) instead of on every poll.
 */
@Injectable()
export class TimerPoller implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  /** The sweep in flight, so shutdown can wait for it instead of racing the store's close. */
  private current: Promise<boolean> | undefined;
  private unsubscribeEnqueued?: () => void;
  private unsubscribeEvents?: () => void;
  /** Set by shutdown: the backoff loop stops scheduling polls. */
  private stopped = false;
  /** Something happened (a run event, an enqueue nudge) since the last poll started. */
  private activity = false;
  /** Ends the backoff loop's current wait early (set only while it waits). */
  private endWait: (() => void) | undefined;
  /** When the owed-lifecycle listing last succeeded (see {@link owedSweepDue}). */
  private owedSweptAt: number | undefined;
  /** When the tenant schedule announcements were last reconciled (see {@link announcedSchedules}). */
  private announcedSyncedAt: number | undefined;

  constructor(
    private readonly engine: WorkflowEngine,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
    // Fleet-wide sweeps run under a `@nestjs/locks` lease when the app has `LocksModule` (detected).
    @Optional() private readonly leases: SweepLeases = new SweepLeases(),
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // A schedule whose `workflow` is a class that was never decorated would only fail on its first
    // fire, logged and retried every tick. Resolve every class now so the app fails to boot instead.
    for (const s of this.options.schedules ?? []) workflowName(s.workflow);
    // Drive suspended runs forward when this operator instance is DRIVING (defaults to true) — it
    // may execute locally or dispatch remotely (group-served / convention), either way it drives. A
    // non-driving (dashboard-only) operator, or a thin worker with no `store` at all, must not
    // resume timers — leave that to a driving instance.
    if (!isDrivingOperator(this.options)) return;
    // A driving instance consumes the transport's run queue when the transport carries one, so the
    // runs any instance starts (a `ctx.all` fan's children included), re-dispatches or finds due
    // spread over every driving instance. `engine.beginDrain` (below, at shutdown) stops it, and
    // the registrar's `drain` waits for the runs it holds within `shutdownTimeoutMs`. Optional for
    // an older core.
    this.engine.consumeRuns?.();
    // Low-latency dispatch: when a run is enqueued elsewhere (e.g. an API pod), pick it up at once
    // over the control plane instead of waiting for the next poll tick. Leasing dedups across workers.
    // The `.catch` is load-bearing, not decorative: this is fire-and-forget, so an unhandled
    // rejection here terminates the process under Node's default policy — and the run it could not
    // drive is still waiting for the next poll tick either way.
    //
    // `runEnqueued` is bounded and skips a run another instance already took; every instance
    // receives every announcement, so a wide fan would otherwise lease and replay every child here
    // at once. Optional for an older core.
    this.unsubscribeEnqueued = this.engine.onEnqueued((runId) => {
      this.noteActivity();
      if (typeof this.engine.runEnqueued === 'function') {
        this.engine.runEnqueued(runId);
        return;
      }
      void this.engine.runOne(runId).catch((error) => {
        console.error(`[nestjs-durable] could not run enqueued run ${runId}:`, error);
      });
    });
    const intervalMs = this.options.timerPollMs ?? 1_000;
    const maxIdleMs = this.options.maxIdleIntervalMs ?? 5_000;
    if (intervalMs > 0 && maxIdleMs > intervalMs && this.canBackOff()) {
      // Any run event, local or from another instance (control plane), ends an idle wait.
      this.unsubscribeEvents = this.engine.subscribe(() => this.noteActivity());
      void this.loop(intervalMs, maxIdleMs);
      return;
    }
    void this.poll();
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.poll(), intervalMs);
      this.timer.unref?.();
    }
  }

  /**
   * Whether polls may be spaced out while idle: the engine must reach new runs without the
   * pending-run poll and say when its next timer is due, and the in-process schedules must be able
   * to say when their next window is. Optional calls throughout: an older core keeps the fixed tick.
   */
  private canBackOff(): boolean {
    if (this.engine.idleBackoffSupported !== true) return false;
    if (typeof this.engine.nextDueAt !== 'function') return false;
    if ((this.options.schedules?.length ?? 0) > 0 && nextScheduleFireAt === undefined) return false;
    return true;
  }

  private noteActivity(): void {
    this.activity = true;
    this.endWait?.();
  }

  /**
   * Poll, then wait: `intervalMs` after a poll that found work (or while anything happened), else
   * twice the last wait up to `maxIdleMs`, cut short so the next poll runs no later than the earliest
   * known due time. A run event or an enqueue nudge ends a wait at once.
   */
  private async loop(intervalMs: number, maxIdleMs: number): Promise<void> {
    let wait = intervalMs;
    while (!this.stopped) {
      // Whatever arrived during the wait (it ended the wait) counts as this poll's work.
      const arrived = this.activity;
      this.activity = false;
      const worked = await this.poll();
      if (this.stopped) return;
      const idle = !worked && !arrived && !this.activity;
      wait = idle ? Math.min(wait * 2, maxIdleMs) : intervalMs;
      let next = wait;
      if (next > intervalMs) next = await this.untilDue(next, intervalMs);
      if (this.stopped) return;
      if (this.activity) next = Math.min(next, intervalMs); // something happened during the read
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.endWait = undefined;
          resolve();
        };
        const timer = setTimeout(done, next);
        timer.unref?.();
        // Only a wait longer than the regular tick is ended early; shutdown ends any.
        this.endWait = () => {
          if (this.stopped || next > intervalMs) done();
        };
      });
    }
  }

  /**
   * `wait`, shortened so the next poll runs no later than the earliest known due time: the engine's
   * next timer, blocked-run recovery poll or persisted schedule, and the next window of the
   * in-process `schedules`. Never below `intervalMs` (the regular tick catches what is due sooner). A
   * failed read keeps the regular tick.
   */
  private async untilDue(wait: number, intervalMs: number): Promise<number> {
    try {
      const now = Date.now();
      const stored = await this.engine.nextDueAt(now + wait, {
        persistedSchedules: this.options.persistedSchedules === true,
        announcedSchedules: this.announcedSchedules() !== undefined,
      });
      const schedules = this.options.schedules;
      const scheduled =
        schedules && schedules.length > 0 && nextScheduleFireAt
          ? nextScheduleFireAt(this.engine, schedules, now)
          : undefined;
      let due = wait;
      for (const at of [stored, scheduled]) {
        if (at !== undefined) due = Math.min(due, at - Date.now());
      }
      return Math.max(intervalMs, due);
    } catch {
      return intervalMs;
    }
  }

  /**
   * The tenant schedule adoption settings when it is on (see
   * {@link DurableModuleOptions.announcedSchedules}), else undefined: off by option, on a core
   * without it, or on a store that does not persist schedules.
   */
  private announcedSchedules(): { syncMs: number; graceMs: number | undefined } | undefined {
    const option = this.options.announcedSchedules;
    if (option === false) return undefined;
    if (typeof this.engine.syncAnnouncedSchedules !== 'function') return undefined;
    if (this.engine.schedules?.supported !== true) return undefined;
    const settings = typeof option === 'object' ? option : {};
    return { syncMs: settings.syncMs ?? 15_000, graceMs: settings.graceMs };
  }

  /**
   * Whether this poll lists the owed lifecycle runs: until a sweep that listed them succeeded, then
   * once per `owedLifecycleSweepMs` (a clock that went back lists them again).
   */
  private owedSweepDue(now: number): boolean {
    const every = this.options.owedLifecycleSweepMs ?? 10_000;
    const last = this.owedSweptAt;
    return every <= 0 || last === undefined || now < last || now - last >= every;
  }

  /**
   * Stop polling and wait for the sweep in flight (bounded by `shutdownTimeoutMs`, default 10s).
   * Nest runs every `onModuleDestroy` before any `onApplicationShutdown`, so returning here only once
   * the sweep has settled means no store call is still pending when the registrar drains and the
   * host closes its connection pool. The engine is told to stop first so a sweep working through a
   * backlog stops locking runs instead of finishing the backlog. The time spent waiting is deducted
   * from the later `engine.drain()`, so poll wait plus drain stay within one `shutdownTimeoutMs`.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.endWait?.();
    this.unsubscribeEnqueued?.();
    this.unsubscribeEvents?.();
    // Only an operator that DRIVES the engine has a poll to wait for, and only it stops taking work
    // here. A non-driving operator (dashboard-only, `drive: false`) keeps running whatever its
    // finishing requests or `beforeApplicationShutdown` hooks start; `drain()` in the registrar
    // still waits for those.
    if (!isDrivingOperator(this.options)) return;
    // Optional call: an older core (the peer range is wide) has no `beginDrain`, and a TypeError here
    // would reject `app.close()` on Nest 10/11 before the registrar ever drains.
    this.engine.beginDrain?.();
    if (!this.current) return;
    const budget = this.options.shutdownTimeoutMs ?? 10_000;
    const started = Date.now();
    const timedOut = await settleWithin(this.current, budget);
    // Charge the drain only for the time spent waiting here, not for whatever Nest does between this
    // hook and the registrar's drain.
    this.engine.beginDrain?.(Date.now() - started);
    if (timedOut) {
      console.warn(
        `[nestjs-durable] timer poll still running after ${budget}ms at shutdown; continuing (it may report store errors if the host ends its pool now)`,
      );
    }
  }

  /**
   * One sweep of the engine's recovery work.
   *
   * **This method never rejects, and that is a hard requirement rather than defensiveness.** Both
   * callers (the boot kick-off and the interval) fire it as `void`, so a rejection would surface as
   * an unhandled rejection, which is fatal, and would re-occur on the next boot with the same state:
   * a single unrecoverable run would crash-loop every worker in the deployment, taking down every
   * other workflow with it. A poll that goes wrong must cost this tick, not the pod.
   *
   * Each sweep is isolated separately because they are independent: a store that fails
   * `recoverIncomplete` says nothing about whether durable timers should still fire, and skipping
   * the rest of the tick would silently widen one subsystem's outage into all of them.
   */
  private poll(): Promise<boolean> {
    if (this.polling) return this.current ?? Promise.resolve(true); // never overlap two sweeps
    this.polling = true;
    const run = this.pollOnce().finally(() => {
      this.polling = false;
      if (this.current === run) this.current = undefined;
    });
    this.current = run;
    return run;
  }

  /** One poll of every sweep. Resolves whether it found work (or a sweep failed): see {@link loop}. */
  private async pollOnce(): Promise<boolean> {
    let worked = false;
    // Work: a sweep returned runs (or run ids) it acted on, or failed (the loop keeps the regular
    // tick so the failure is retried soon).
    const note = (result: unknown) => {
      if (result === SWEEP_FAILED || (Array.isArray(result) && result.length > 0)) worked = true;
    };
    // Pick up runs enqueued elsewhere (an API pod's `start`, or another worker) still `pending`,
    // reclaim runs orphaned by a crashed worker (lease expired — a live worker renews its lease so
    // only dead ones are reclaimed), then resume due timers and sweep execution timeouts.
    note(await this.sweep('runPending', () => this.engine.runPending()));
    note(await this.sweep('recoverIncomplete', () => this.engine.recoverIncomplete()));
    note(await this.sweep('resumeDueTimers', () => this.engine.resumeDueTimers()));
    note(await this.sweep('sweepTimeouts', () => this.engine.sweepTimeouts()));
    // The stalled-run pager: throttled to a pass a minute inside the engine, a no-op without an
    // `onStalled` listener. Optional call: an older core (the peer range is wide) has no sweep.
    // One pod pages when `@nestjs/locks` is present (see SweepLeases); every pod otherwise.
    note(
      await this.sweep('sweepStalled', () =>
        this.leases.run('stalled-pager', async () => this.engine.sweepStalled?.()),
      ),
    );
    // Buffered child completions no parent will consume: a few pages per tick until a pass ends,
    // then a rest (throttled inside the engine). Optional call, like the stalled sweep.
    note(
      await this.sweep('sweepBufferedSignals', () =>
        this.leases.run('buffered-signals', async () => this.engine.sweepBufferedSignals?.()),
      ),
    );
    // Signal dedupe ids past their TTL (`signal(..., { id })`): a few bounded deletes per tick, one
    // pod at a time like the buffered-signals sweep.
    note(
      await this.sweep('sweepExpiredSignalIds', () =>
        this.leases.run('signal-ids', async () => this.engine.sweepExpiredSignalIds?.()),
      ),
    );
    // Lifecycle events a settled run still owes to a subscriber this instance has (its process
    // died before publishing, or did not have the subscriber), and `ctx.waitForRun` waits whose
    // run settled without resuming them. The owed listing (a tag filter over settled runs) and the
    // heal run once per `owedLifecycleSweepMs`; the run waits every poll. Only a listing that got
    // through starts the interval: a failed one is retried on the next poll. Optional call, like
    // the sweeps above (an older core ignores the third argument and sweeps everything).
    const now = Date.now();
    const owed = this.owedSweepDue(now);
    note(
      await this.sweep('sweepLifecycleEvents', async () => {
        const published = await this.engine.sweepLifecycleEvents?.(undefined, undefined, {
          owed,
        });
        if (owed) this.owedSweptAt = now;
        return published;
      }),
    );
    const schedules = this.options.schedules;
    if (schedules && schedules.length > 0) {
      note(await this.sweep('schedules', () => runSchedules(this.engine, schedules, Date.now())));
    }
    const announced = this.announcedSchedules();
    if (announced) {
      // Reconcile what tenant apps announce, once per `syncMs` and on one pod at a time when
      // `@nestjs/locks` is present. Only a sync that got through starts the interval.
      const at = Date.now();
      const last = this.announcedSyncedAt;
      if (last === undefined || at < last || at - last >= announced.syncMs) {
        await this.sweep('announcedSchedules', () =>
          this.leases.run('announced-schedules', async () => {
            await this.engine.syncAnnouncedSchedules({
              ...(announced.graceMs !== undefined ? { graceMs: announced.graceMs } : {}),
            });
            this.announcedSyncedAt = at;
          }),
        );
      }
    }
    if (this.options.persistedSchedules) {
      // Every persisted schedule, the adopted tenant ones included.
      note(await this.sweep('persistedSchedules', () => this.engine.schedules.tick()));
    } else if (announced) {
      note(
        await this.sweep('announcedScheduleFires', () =>
          this.engine.schedules.tick(Date.now(), { tag: ANNOUNCED_SCHEDULE_TAG }),
        ),
      );
    }
    return worked;
  }

  /** Run one sweep, absorbing and reporting its failure — see {@link poll}. */
  private async sweep(name: string, run: () => Promise<unknown>): Promise<unknown> {
    try {
      return await run();
    } catch (error) {
      console.error(`[nestjs-durable] timer poll: ${name} failed; continuing:`, error);
      return SWEEP_FAILED;
    }
  }
}
