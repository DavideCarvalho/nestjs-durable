import {
  type EngineEvent,
  type MetricsCollector,
  type RunQuery,
  type RunResult,
  STATE_STORE,
  type StateStore,
  type StepCheckpoint,
  type UpdateResult,
  WorkflowEngine,
  type WorkflowRun,
  collectMetrics,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';

export interface RunDetail {
  run: WorkflowRun;
  /** Steps in execution order — the end-to-end timeline (local + remote). */
  timeline: StepCheckpoint[];
  /** Ids of runs this run spawned (ctx.child / ctx.startChild) — the parent→children tree. */
  children: string[];
}

/** Read-model and actions backing the control-plane UI. */
@Injectable()
export class DashboardService {
  /** Prometheus counters accumulated from engine events since boot (per process). */
  private readonly metricsCollector: MetricsCollector;

  constructor(
    @Inject(STATE_STORE) private readonly store: StateStore,
    private readonly engine: WorkflowEngine,
  ) {
    this.metricsCollector = collectMetrics(this.engine);
  }

  /**
   * Prometheus-text metrics for a `/metrics` scrape: the event-counters (runs/steps by outcome,
   * per-workflow counts) plus live **backlog gauges** queried at scrape time — `durable_pending_runs`
   * (the dispatch backlog: the key health signal of the dispatch model) and `durable_dead_runs` (DLQ
   * size). Capped per status so the scrape can't load an unbounded result set.
   */
  async metrics(): Promise<string> {
    const cap = 10_000;
    const [pending, running, dead] = await Promise.all([
      this.store.listRuns({ status: 'pending', limit: cap }),
      this.store.listRuns({ status: 'running', limit: cap }),
      this.store.listRuns({ status: 'dead', limit: cap }),
    ]);
    const gauges = [
      '# TYPE durable_pending_runs gauge',
      `durable_pending_runs ${pending.length}`,
      '# TYPE durable_running_runs gauge',
      `durable_running_runs ${running.length}`,
      '# TYPE durable_dead_runs gauge',
      `durable_dead_runs ${dead.length}`,
    ].join('\n');
    return `${this.metricsCollector.prometheus()}${gauges}\n`;
  }

  listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    return this.store.listRuns(query);
  }

  async getRunDetail(runId: string): Promise<RunDetail | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const [timeline, children] = await Promise.all([
      this.store.listCheckpoints(runId),
      this.engine.getRunChildren(runId), // canonical parent→children edge (shared with cancel cascade)
    ]);
    return { run, timeline, children };
  }

  /** Fix-and-replay a dead/failed run with a corrected input — a fresh linked run. Returns its id. */
  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    return this.engine.retryWithInput(runId, input);
  }

  /** Re-run a failed/incomplete run; completed steps replay from their checkpoints. */
  retry(runId: string): Promise<RunResult | null> {
    // Re-enqueue (dispatch model) instead of resuming inline, so the request can't hang on workflow
    // execution — a worker picks the run up and replays it.
    return this.engine.requeue(runId);
  }

  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return this.engine.cancel(runId, opts);
  }

  /**
   * Apply `retry` or `cancel` to every run matching a filter (status / tag / workflow) — e.g. "retry
   * every `dead` run tagged `type:mel`". Capped at 500 runs per call; runs that can't be acted on
   * (already terminal) are skipped. Returns how many matched and how many the action applied to.
   */
  async bulk(
    action: 'retry' | 'cancel',
    filter: Pick<RunQuery, 'status' | 'tag' | 'workflow' | 'attributes'>,
    opts?: { compensate?: boolean },
  ): Promise<{ matched: number; applied: number }> {
    const runs = await this.store.listRuns({ ...filter, limit: 500 });
    let applied = 0;
    for (const r of runs) {
      try {
        if (action === 'retry') await this.engine.requeue(r.id);
        else await this.engine.cancel(r.id, opts);
        applied += 1;
      } catch {
        // Skip a run that can't take the action (e.g. already terminal) — keep going.
      }
    }
    return { matched: runs.length, applied };
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
