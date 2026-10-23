import {
  DURABLE_OPTIONS_CANONICAL,
  WorkflowEngine,
  runSchedules,
  workflowName,
} from '@dudousxd/nestjs-durable-core';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { DurableModuleOptions } from './durable.module';
import { isDrivingOperator } from './role';
import { settleWithin } from './settle-within';

/**
 * Resumes suspended runs whose durable timer (`ctx.sleep`) is due, and fires any configured
 * recurring `schedules` (plus the persisted `engine.schedules` when `persistedSchedules` is on) —
 * once on boot, then on an interval. Set `timerPollMs` to `0` to disable
 * the interval (e.g. when an external scheduler drives `WorkflowEngine.resumeDueTimers`).
 */
@Injectable()
export class TimerPoller implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  /** The sweep in flight, so shutdown can wait for it instead of racing the store's close. */
  private current: Promise<void> | undefined;
  private unsubscribeEnqueued?: () => void;

  constructor(
    private readonly engine: WorkflowEngine,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
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
      if (typeof this.engine.runEnqueued === 'function') {
        this.engine.runEnqueued(runId);
        return;
      }
      void this.engine.runOne(runId).catch((error) => {
        console.error(`[nestjs-durable] could not run enqueued run ${runId}:`, error);
      });
    });
    await this.poll();
    const intervalMs = this.options.timerPollMs ?? 1_000;
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.poll(), intervalMs);
      this.timer.unref?.();
    }
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
    if (this.timer) clearInterval(this.timer);
    this.unsubscribeEnqueued?.();
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
   * **This method never rejects, and that is a hard requirement rather than defensiveness.** It has
   * exactly two callers and a rejection out of either one kills the process: on boot it is awaited
   * inside `onApplicationBootstrap`, so the rejection propagates through `NestApplication.init()`
   * into the host's `bootstrap()`; on the interval it is a fire-and-forget `void`, so it surfaces as
   * an unhandled rejection. Both are fatal, and both re-occur on the next boot with the same state,
   * so a single unrecoverable run crash-loops every worker in the deployment — taking down every
   * other workflow with it. A poll that goes wrong must cost this tick, not the pod.
   *
   * Each sweep is isolated separately because they are independent: a store that fails
   * `recoverIncomplete` says nothing about whether durable timers should still fire, and skipping
   * the rest of the tick would silently widen one subsystem's outage into all of them.
   */
  private poll(): Promise<void> {
    if (this.polling) return this.current ?? Promise.resolve(); // never overlap two sweeps
    this.polling = true;
    const run = this.pollOnce().finally(() => {
      this.polling = false;
      if (this.current === run) this.current = undefined;
    });
    this.current = run;
    return run;
  }

  private async pollOnce(): Promise<void> {
    {
      // Pick up runs enqueued elsewhere (an API pod's `start`, or another worker) still `pending`,
      // reclaim runs orphaned by a crashed worker (lease expired — a live worker renews its lease so
      // only dead ones are reclaimed), then resume due timers and sweep execution timeouts.
      await this.sweep('runPending', () => this.engine.runPending());
      await this.sweep('recoverIncomplete', () => this.engine.recoverIncomplete());
      await this.sweep('resumeDueTimers', () => this.engine.resumeDueTimers());
      await this.sweep('sweepTimeouts', () => this.engine.sweepTimeouts());
      // The stalled-run pager: throttled to a pass a minute inside the engine, a no-op without an
      // `onStalled` listener. Optional call: an older core (the peer range is wide) has no sweep.
      await this.sweep('sweepStalled', async () => this.engine.sweepStalled?.());
      const schedules = this.options.schedules;
      if (schedules && schedules.length > 0) {
        await this.sweep('schedules', () => runSchedules(this.engine, schedules, Date.now()));
      }
      if (this.options.persistedSchedules) {
        await this.sweep('persistedSchedules', () => this.engine.schedules.tick());
      }
    }
  }

  /** Run one sweep, absorbing and reporting its failure — see {@link poll}. */
  private async sweep(name: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      console.error(`[nestjs-durable] timer poll: ${name} failed; continuing:`, error);
    }
  }
}
