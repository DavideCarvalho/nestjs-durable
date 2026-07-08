import type {
  EngineEvent,
  GroupHealth,
  RunQuery,
  RunResult,
  StepCheckpoint,
  WorkflowRun,
} from './interfaces';

/** Which durable topology a gateway speaks for — surfaced in the dashboard so an operator can tell a
 *  control plane from a tenant at a glance (the store-backed gateway is the operator; the proxy is a
 *  tenant). Cheap, synchronous, local knowledge — no round-trip. */
export interface DurableTopology {
  role: 'control-plane' | 'tenant';
  /** The tenant's isolation partition name; set only when `role` is 'tenant'. */
  tenant?: string;
}

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
 * (no metrics/bulk/update/signal) — those stay control-plane-only. `workerHealth` IS on the port: the
 * operator answers it scoped to the requester's own groups, so a tenant's Workers panel works too.
 */
export interface RunGateway {
  /** This deployment's durable role (control plane vs tenant) — synchronous local metadata. */
  topology(): DurableTopology;
  getRunDetail(runId: string): Promise<RunDetail | null>;
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
  /** Per-group worker health (queue backlog + live worker heartbeats). On the control plane this is
   *  every group; over a tenant proxy the operator scopes it to the tenant's own groups. */
  workerHealth(): Promise<GroupHealth[]>;
  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null>;
  retry(runId: string): Promise<RunResult | null>;
  continue(runId: string): Promise<RunResult | null>;
  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null>;
  /** Live lifecycle events for one run; returns an unsubscribe fn. Framework-agnostic (no rxjs). */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void;
}
