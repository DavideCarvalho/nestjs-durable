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
    // Drive suspended runs forward when this instance's `drive` axis is on — defaults to the
    // worker role (back-compat), but a `DurableControlPlaneModule` (`worker:false, drive:true`)
    // also drives: it dispatches remotely instead of executing locally. A plain dashboard-only
    // instance (`worker:false`, drive unset) must not resume timers — leave that to the workers.
    const drive = this.options.drive ?? this.options.worker !== false;
    if (!drive) return;
    // Low-latency dispatch: when a run is enqueued elsewhere (e.g. an API pod), pick it up at once
    // over the control plane instead of waiting for the next poll tick. Leasing dedups across workers.
    this.unsubscribeEnqueued = this.engine.onEnqueued((runId) => void this.engine.runOne(runId));
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

  private async poll(): Promise<void> {
    if (this.polling) return; // never overlap two sweeps
    this.polling = true;
    try {
      // Pick up runs enqueued elsewhere (an API pod's `start`, or another worker) still `pending`,
      // reclaim runs orphaned by a crashed worker (lease expired — a live worker renews its lease so
      // only dead ones are reclaimed), then resume due timers and sweep execution timeouts.
      await this.engine.runPending();
      await this.engine.recoverIncomplete();
      await this.engine.resumeDueTimers();
      await this.engine.sweepTimeouts();
      const schedules = this.options.schedules;
      if (schedules && schedules.length > 0) {
        await runSchedules(this.engine, schedules, Date.now());
      }
    } finally {
      this.polling = false;
    }
  }
}
