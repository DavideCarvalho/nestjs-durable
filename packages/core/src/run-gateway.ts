import type {
  EngineEvent,
  GroupHealth,
  RunFacetQuery,
  RunFacetRow,
  RunQuery,
  RunResult,
  RunValueAxis,
  RunValueFacetOptions,
  RunValueFacetRow,
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

/** A run + its timeline + child ids — the detail view. Single source of truth: the dashboard server
 *  re-exports this instead of re-declaring it, and the dashboard client derives its wire mirror from
 *  it via {@link WireDates} instead of hand-mirroring field by field. */
export interface RunDetail {
  run: WorkflowRun;
  /** Steps in execution order (local + remote). */
  timeline: StepCheckpoint[];
  /** Ids of runs this run spawned (parent→children tree). */
  children: string[];
}

/**
 * Maps every `Date` (and `Date | undefined`) field of `T` to its ISO-string wire form — the shape a
 * JSON response actually carries once dates cross the wire (`JSON.stringify` already does this
 * coercion; this just types it). Homomorphic: each field keeps its own optional modifier, so a
 * required `Date` becomes a required `string` and an optional one stays optional. Lets a consumer
 * derive its own wire-facing client type from a core server type (e.g. the dashboard's SPA `WorkflowRun`/
 * `StepCheckpoint`/`RunDetail`) instead of hand-mirroring it field by field and drifting.
 */
export type WireDates<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | undefined
      ? string | undefined
      : T[K];
};

/**
 * The bounded read/control/stream surface a consumer (e.g. a controller) needs, satisfied by BOTH
 * topologies: the control plane binds a store-backed impl (reuses `DashboardService`); a tenant binds
 * a `ProxyRunGateway` that round-trips over the transport. Deliberately smaller than the full dashboard
 * (no metrics/bulk/update/signal) — those stay control-plane-only. `workerHealth` IS on the port: the
 * operator answers it scoped to the requester's own groups, so a tenant's Workers panel works too.
 *
 * Declared as an **abstract class** rather than an interface so it doubles as its own NestJS DI token
 * (the idiomatic inject-by-type pattern): providers bind `{ provide: RunGateway, useClass/useFactory }`
 * and consumers inject `constructor(private readonly gateway: RunGateway)` with no string/symbol token.
 * `StoreRunGateway`/`ProxyRunGateway` `implements RunGateway`; abstract methods carry no body, so the
 * emitted runtime class is an empty, non-instantiable shell used only as the token.
 */
export abstract class RunGateway {
  /** This deployment's durable role (control plane vs tenant) — synchronous local metadata. */
  abstract topology(): DurableTopology;
  abstract getRunDetail(runId: string): Promise<RunDetail | null>;
  /** List runs, each optionally carrying a {@link RunWaiting} descriptor (what a suspended run is
   *  parked on). The store-backed gateway resolves `waiting`; a proxy relays whatever the control
   *  plane sent. */
  abstract listRuns(query: RunQuery): Promise<RunListItem[]>;
  /**
   * Counts of the runs matching `query`, grouped by `(status, origin)` — what a console's status and
   * origin chips display. Separate from {@link listRuns} precisely so the list can be PAGINATED: the
   * page bounds what is rendered, these counts stay whole-set exact. Zero-count cells are absent.
   */
  abstract runFacets(query: RunFacetQuery): Promise<RunFacetRow[]>;
  /**
   * The distinct values of one filter axis over the runs matching `query`, with counts — what fills a
   * console's tenant/tag/attribute pickers. On the port (not control-plane-only) because the pickers
   * belong to the same panel as {@link listRuns}: a tenant that can list its runs has to be able to
   * see what it may filter them by, or its console offers a blank dropdown.
   *
   * Returns `[]` when the underlying store does not implement the enumeration — an empty picker with
   * free-text entry still standing, not an error.
   */
  abstract runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]>;
  /**
   * Bulk-resolve {@link RunWaiting} for an arbitrary set of run ids — for a consumer with its OWN
   * filtered/paginated run listing (so it isn't just `listRuns` under another name) that needs to know
   * which of ITS runs are parked on a breakpoint (or any other event wait) without re-deriving the bulk
   * waiter scan itself or reaching for raw SQL against `durable_step_checkpoints`. A `Record` (not a
   * `Map`) because `ProxyRunGateway` serialises the reply over the transport as plain JSON. Entries are
   * present ONLY for runs currently waiting — an unknown id, a non-suspended id, and a suspended id
   * parked on something non-event (a bare `ctx.sleep`, an in-flight step) are simply absent, same as a
   * `listRuns` row with no `waiting`.
   */
  abstract waitingFor(runIds: string[]): Promise<Record<string, RunWaiting>>;
  /** Per-group worker health (queue backlog + live worker heartbeats). On the control plane this is
   *  every group; over a tenant proxy the operator scopes it to the tenant's own groups. */
  abstract workerHealth(): Promise<GroupHealth[]>;
  abstract cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null>;
  abstract retry(runId: string): Promise<RunResult | null>;
  abstract continue(runId: string): Promise<RunResult | null>;
  /** Re-dispatch every remote step of a run stuck `pending` — the operator recovery for a LOST step
   *  dispatch (crashed worker / dropped job) that no automatic path re-drives. Returns the run's status
   *  plus how many steps were re-dispatched, or null if the run is unknown. */
  abstract redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null>;
  abstract retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null>;
  /** Live lifecycle events for one run; returns an unsubscribe fn. Framework-agnostic (no rxjs). */
  abstract subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void;
}
