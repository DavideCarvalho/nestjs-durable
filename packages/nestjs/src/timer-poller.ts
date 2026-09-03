import {
  DURABLE_OPTIONS_CANONICAL,
  WorkflowEngine,
  runSchedules,
} from '@dudousxd/nestjs-durable-core';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { DurableModuleOptions } from './durable.module';
import { isDrivingOperator } from './role';

/**
 * Resumes suspended runs whose durable timer (`ctx.sleep`) is due, and fires any configured
 * recurring `schedules` — once on boot, then on an interval. Set `timerPollMs` to `0` to disable
 * the interval (e.g. when an external scheduler drives `WorkflowEngine.resumeDueTimers`).
 */
@Injectable()
export class TimerPoller implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private unsubscribeEnqueued?: () => void;

  constructor(
    private readonly engine: WorkflowEngine,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Drive suspended runs forward when this operator instance is DRIVING (defaults to true) — it
    // may execute locally or dispatch remotely (group-served / convention), either way it drives. A
    // non-driving (dashboard-only) operator, or a thin worker with no `store` at all, must not
    // resume timers — leave that to a driving instance.
    if (!isDrivingOperator(this.options)) return;
    // Low-latency dispatch: when a run is enqueued elsewhere (e.g. an API pod), pick it up at once
    // over the control plane instead of waiting for the next poll tick. Leasing dedups across workers.
    // The `.catch` is load-bearing, not decorative: this is fire-and-forget, so an unhandled
    // rejection here terminates the process under Node's default policy — and the run it could not
    // drive is still waiting for the next poll tick either way.
    this.unsubscribeEnqueued = this.engine.onEnqueued((runId) => {
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

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribeEnqueued?.();
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
  private async poll(): Promise<void> {
    if (this.polling) return; // never overlap two sweeps
    this.polling = true;
    try {
      // Pick up runs enqueued elsewhere (an API pod's `start`, or another worker) still `pending`,
      // reclaim runs orphaned by a crashed worker (lease expired — a live worker renews its lease so
      // only dead ones are reclaimed), then resume due timers and sweep execution timeouts.
      await this.sweep('runPending', () => this.engine.runPending());
      await this.sweep('recoverIncomplete', () => this.engine.recoverIncomplete());
      await this.sweep('resumeDueTimers', () => this.engine.resumeDueTimers());
      await this.sweep('sweepTimeouts', () => this.engine.sweepTimeouts());
      const schedules = this.options.schedules;
      if (schedules && schedules.length > 0) {
        await this.sweep('schedules', () => runSchedules(this.engine, schedules, Date.now()));
      }
    } finally {
      this.polling = false;
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
