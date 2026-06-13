import {
  type EngineEvent,
  type RunQuery,
  type RunResult,
  STATE_STORE,
  type StateStore,
  type StepCheckpoint,
  type UpdateResult,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';

export interface RunDetail {
  run: WorkflowRun;
  /** Steps in execution order — the end-to-end timeline (local + remote). */
  timeline: StepCheckpoint[];
}

/** Read-model and actions backing the control-plane UI. */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(STATE_STORE) private readonly store: StateStore,
    private readonly engine: WorkflowEngine,
  ) {}

  listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    return this.store.listRuns(query);
  }

  async getRunDetail(runId: string): Promise<RunDetail | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const timeline = await this.store.listCheckpoints(runId);
    return { run, timeline };
  }

  /** Re-run a failed/incomplete run; completed steps replay from their checkpoints. */
  retry(runId: string): Promise<RunResult> {
    return this.engine.resume(runId);
  }

  cancel(runId: string): Promise<RunResult | null> {
    return this.engine.cancel(runId);
  }

  /** Resume a run paused at a `ctx.breakpoint` (the "continue" button). */
  continue(runId: string): Promise<RunResult | null> {
    return this.engine.continue(runId);
  }

  /**
   * Deliver a `ctx.webhook()` callback: turn an inbound POST (token + body) into the signal the
   * waiting run is parked on. Returns the run result, or `null` if no run waits on that token (a
   * stale/duplicate callback) — a safe no-op the controller maps to 404.
   */
  deliverWebhook(token: string, body: unknown): Promise<RunResult | null> {
    return this.engine.signal(token, body);
  }

  /** Side-effect-free read of a value a run published via `ctx.setEvent` (a live query). */
  getEvent(runId: string, key: string): Promise<unknown> {
    return this.engine.getEvent(runId, key);
  }

  /** Deliver a validated `ctx.onUpdate` to a run; the validator may reject it (see UpdateResult). */
  update(runId: string, name: string, arg: unknown): Promise<UpdateResult> {
    return this.engine.update(runId, name, arg);
  }

  /**
   * Live stream of a run's lifecycle events for SSE. Backed by `engine.subscribe`, which — when the
   * transport has a control plane — receives events from EVERY instance, so a dashboard-only pod
   * tails a run executing on a worker pod. Without a control plane it only sees same-process events.
   */
  streamRun(runId: string): Observable<{ data: EngineEvent }> {
    return new Observable<{ data: EngineEvent }>((subscriber) => {
      const off = this.engine.subscribe((event) => {
        if (event.runId === runId) subscriber.next({ data: event });
      });
      return () => off();
    });
  }
}
