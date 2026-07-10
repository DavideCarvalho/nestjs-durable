import type {
  EngineEvent,
  GroupHealth,
  RunQuery,
  RunResult,
  RunWaiting,
  StepCheckpoint,
  WorkflowRun,
} from './interfaces';

/** A run as returned by the gateway's list — the durable run plus an optional {@link RunWaiting}
 *  descriptor the control plane resolves (what a suspended run is parked on), so the dashboard can
 *  name the wait in a list row without fetching each run's timeline. Additive: `waiting` is absent
 *  on a non-parked run and on gateways/versions that don't compute it. */
export type RunListItem = WorkflowRun & { waiting?: RunWaiting | undefined };

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
  /** List runs, each optionally carrying a {@link RunWaiting} descriptor (what a suspended run is
   *  parked on). The store-backed gateway resolves `waiting`; a proxy relays whatever the control
   *  plane sent. */
  listRuns(query: RunQuery): Promise<RunListItem[]>;
  /** Per-group worker health (queue backlog + live worker heartbeats). On the control plane this is
   *  every group; over a tenant proxy the operator scopes it to the tenant's own groups. */
  workerHealth(): Promise<GroupHealth[]>;
  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null>;
  retry(runId: string): Promise<RunResult | null>;
  continue(runId: string): Promise<RunResult | null>;
  /** Re-dispatch every remote step of a run stuck `pending` — the operator recovery for a LOST step
   *  dispatch (crashed worker / dropped job) that no automatic path re-drives. Returns the run's status
   *  plus how many steps were re-dispatched, or null if the run is unknown. */
  redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null>;
  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null>;
  /** Live lifecycle events for one run; returns an unsubscribe fn. Framework-agnostic (no rxjs). */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void;
}
