import {
  type EngineEvent,
  type GroupHealth,
  type MetricsCollector,
  type RunGateway,
  type RunQuery,
  type RunResult,
  STATE_STORE_CANONICAL,
  type StateStore,
  type StepCheckpoint,
  type UpdateResult,
  WorkflowEngine,
  type WorkflowRun,
  collectMetrics,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';
import { RUN_GATEWAY } from './tokens.js';

export interface RunDetail {
  run: WorkflowRun;
  /** Steps in execution order — the end-to-end timeline (local + remote). */
  timeline: StepCheckpoint[];
  /** Ids of runs this run spawned (ctx.child / ctx.startChild) — the parent→children tree. */
  children: string[];
}

/**
 * Read-model and actions backing the control-plane UI. Run-facing ops (list/detail/retry/cancel/
 * continue/retryWithInput/stream/bulk) route through the injected {@link RUN_GATEWAY} port, which
 * the lib binds on both topologies (a store-backed impl on the control plane, a proxy over the
 * transport on a store-less tenant) — so those ops work regardless of whether `store`/`engine`
 * are present. Operator-only ops (metrics/workerHealth/deliverWebhook/getEvent/update) still need
 * direct `store`/`engine` access; they stay `@Optional()` and throw a clear error when absent.
 */
@Injectable()
export class DashboardService {
  /** Prometheus counters accumulated from engine events since boot (per process); undefined on a
   *  store-less tenant (no engine to accumulate from). */
  private readonly metricsCollector: MetricsCollector | undefined;

  constructor(
    @Inject(RUN_GATEWAY) private readonly gateway: RunGateway,
    @Optional() @Inject(STATE_STORE_CANONICAL) private readonly store?: StateStore,
    @Optional() private readonly engine?: WorkflowEngine,
  ) {
    this.metricsCollector = this.engine ? collectMetrics(this.engine) : undefined;
  }

  private requireEngine(): WorkflowEngine {
    if (!this.engine) {
      throw new Error(
        'This durable dashboard operation requires the control plane (no engine on a tenant deployment).',
      );
    }
    return this.engine;
  }

  private requireStore(): StateStore {
    if (!this.store) {
      throw new Error(
        'This durable dashboard operation requires the control plane (no store on a tenant deployment).',
      );
    }
    return this.store;
  }

  /**
   * Prometheus-text metrics for a `/metrics` scrape: the event-counters (runs/steps by outcome,
   * per-workflow counts) plus live **backlog gauges** queried at scrape time — `durable_pending_runs`
   * (the dispatch backlog: the key health signal of the dispatch model) and `durable_dead_runs` (DLQ
   * size). Capped per status so the scrape can't load an unbounded result set. Control-plane-only.
   */
  async metrics(): Promise<string> {
    const store = this.requireStore();
    const engine = this.requireEngine();
    const cap = 10_000;
    const [pending, running, dead] = await Promise.all([
      store.listRuns({ status: 'pending', limit: cap }),
      store.listRuns({ status: 'running', limit: cap }),
      store.listRuns({ status: 'dead', limit: cap }),
    ]);
    const gauges = [
      '# TYPE durable_pending_runs gauge',
      `durable_pending_runs ${pending.length}`,
      '# TYPE durable_running_runs gauge',
      `durable_running_runs ${running.length}`,
      '# TYPE durable_dead_runs gauge',
      `durable_dead_runs ${dead.length}`,
    ];
    // Per-group worker health: backlog vs. live workers. `depth>0 && live==0` is the alert (work
    // piling up with no consumer) — expressible as a Prometheus rule on these two series.
    const health = await engine.workerHealth();
    if (health.length > 0) {
      gauges.push('# TYPE durable_group_queue_depth gauge');
      for (const h of health) {
        gauges.push(`durable_group_queue_depth{group="${h.group}"} ${h.depth}`);
      }
      gauges.push('# TYPE durable_group_live_workers gauge');
      for (const h of health) {
        gauges.push(`durable_group_live_workers{group="${h.group}"} ${h.liveWorkers.length}`);
      }
    }
    return `${this.metricsCollector?.prometheus() ?? ''}${gauges.join('\n')}\n`;
  }

  listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    return this.gateway.listRuns(query);
  }

  /** Per-group worker health (queue backlog + live worker heartbeats) for the Workers panel. The
   *  alert state a row turns red on is `depth > 0 && liveWorkers.length === 0`. Control-plane-only. */
  async workerHealth(): Promise<GroupHealth[]> {
    return this.requireEngine().workerHealth();
  }

  getRunDetail(runId: string): Promise<RunDetail | null> {
    return this.gateway.getRunDetail(runId);
  }

  /** Fix-and-replay a dead/failed run with a corrected input — a fresh linked run. Returns its id. */
  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    return this.gateway.retryWithInput(runId, input);
  }

  /** Re-run a failed/incomplete run; completed steps replay from their checkpoints. */
  retry(runId: string): Promise<RunResult | null> {
    return this.gateway.retry(runId);
  }

  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return this.gateway.cancel(runId, opts);
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
    const runs = await this.gateway.listRuns({ ...filter, limit: 500 });
    let applied = 0;
    for (const r of runs) {
      try {
        if (action === 'retry') await this.gateway.retry(r.id);
        else await this.gateway.cancel(r.id, opts);
        applied += 1;
      } catch {
        // Skip a run that can't take the action (e.g. already terminal) — keep going.
      }
    }
    return { matched: runs.length, applied };
  }

  /** Resume a run paused at a `ctx.breakpoint` (the "continue" button). */
  continue(runId: string): Promise<RunResult | null> {
    return this.gateway.continue(runId);
  }

  /**
   * Deliver a `ctx.webhook()` callback: turn an inbound POST (token + body) into the signal the
   * waiting run is parked on. Returns the run result, or `null` if no run waits on that token (a
   * stale/duplicate callback) — a safe no-op the controller maps to 404. Control-plane-only.
   */
  async deliverWebhook(token: string, body: unknown): Promise<RunResult | null> {
    return this.requireEngine().signal(token, body);
  }

  /** Side-effect-free read of a value a run published via `ctx.setEvent` (a live query). Control-plane-only. */
  async getEvent(runId: string, key: string): Promise<unknown> {
    return this.requireEngine().getEvent(runId, key);
  }

  /** Deliver a validated `ctx.onUpdate` to a run; the validator may reject it (see UpdateResult). Control-plane-only. */
  async update(runId: string, name: string, arg: unknown): Promise<UpdateResult> {
    return this.requireEngine().update(runId, name, arg);
  }

  /**
   * Live stream of a run's lifecycle events for SSE. Backed by `gateway.subscribe`, which — on the
   * control plane — receives events from EVERY instance (so a dashboard-only pod tails a run
   * executing on a worker pod), and on a tenant round-trips over the transport. Either way the
   * gateway already filters to `runId`; the dashboard just wires the events through.
   */
  streamRun(runId: string): Observable<{ data: EngineEvent }> {
    return new Observable<{ data: EngineEvent }>((subscriber) => {
      const off = this.gateway.subscribe(runId, (event) => subscriber.next({ data: event }));
      return () => off();
    });
  }
}
