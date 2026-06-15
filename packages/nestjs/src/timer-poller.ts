import { DURABLE_OPTIONS, WorkflowEngine, runSchedules } from '@dudousxd/nestjs-durable-core';
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

  constructor(
    private readonly engine: WorkflowEngine,
    @Inject(DURABLE_OPTIONS) private readonly options: DurableModuleOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Only the worker role drives suspended runs forward. A dashboard-only instance
    // (`worker: false`) must not resume timers — leave that to the workers.
    if (this.options.worker === false) return;
    await this.poll();
    const intervalMs = this.options.timerPollMs ?? 1_000;
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.poll(), intervalMs);
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
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
