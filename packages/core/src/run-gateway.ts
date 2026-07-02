import type { EngineEvent, RunQuery, RunResult, StepCheckpoint, WorkflowRun } from './interfaces';

/** A run + its timeline + child ids — the detail view. Mirrors the dashboard's `RunDetail`. */
export interface RunDetail {
  run: WorkflowRun;
  /** Steps in execution order (local + remote). */
  timeline: StepCheckpoint[];
  /** Ids of runs this run spawned (parent→children tree). */
  children: string[];
}

/**
 * The bounded read/control/stream surface a consumer (e.g. a controller) needs, satisfied by BOTH
 * topologies: the control plane binds a store-backed impl (reuses `DashboardService`); a tenant binds
 * a `ProxyRunGateway` that round-trips over the transport. Deliberately smaller than the full dashboard
 * (no metrics/bulk/workerHealth/update/signal) — those stay control-plane-only.
 */
export interface RunGateway {
  getRunDetail(runId: string): Promise<RunDetail | null>;
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
  cancel(runId: string): Promise<RunResult | null>;
  retry(runId: string): Promise<RunResult | null>;
  continue(runId: string): Promise<RunResult | null>;
  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null>;
  /** Live lifecycle events for one run; returns an unsubscribe fn. Framework-agnostic (no rxjs). */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void;
}
