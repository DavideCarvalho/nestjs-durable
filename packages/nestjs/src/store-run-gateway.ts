import {
  type DurableTopology,
  type EngineEvent,
  type FanPage,
  type FanPageQuery,
  type GroupHealth,
  type RunDetail,
  type RunDetailOptions,
  type RunFacetQuery,
  type RunFacetRow,
  type RunGateway,
  type RunListItem,
  type RunQuery,
  type RunResult,
  type RunValueAxis,
  type RunValueFacetOptions,
  type RunValueFacetRow,
  type RunWaiting,
  STATE_STORE_CANONICAL,
  SUMMARY_CHILD_LIMIT,
  type StateStore,
  WorkflowEngine,
  type WorkflowRun,
  childIdsOf,
  indexWaitersByRun,
  listSignalWaitersOfRuns,
  mergeRunFacetRows,
  pageFan,
  resolveRunWaiting,
  summarizeTimeline,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable } from '@nestjs/common';

/**
 * Store-backed `RunGateway` — the operator-side implementation, bound to {@link RUN_GATEWAY} on
 * worker/drive instances. Reuses `DashboardService`'s six read/control method bodies verbatim
 * (`dashboard.service.ts:76-172`), so a consumer that only needs the bounded `RunGateway` surface
 * (the `RunRequestResponder`, a thin controller) doesn't have to depend on the dashboard package.
 */
@Injectable()
export class StoreRunGateway implements RunGateway {
  constructor(
    @Inject(STATE_STORE_CANONICAL) private readonly store: StateStore,
    private readonly engine: WorkflowEngine,
  ) {}

  topology(): DurableTopology {
    return { role: 'control-plane' };
  }

  async getRunDetail(runId: string, options?: RunDetailOptions): Promise<RunDetail | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const over = options?.summarizeFansOver;
    if (over === undefined) {
      const [timeline, children] = await Promise.all([
        this.store.listCheckpoints(runId),
        this.engine.getRunChildren(runId), // canonical parent→children edge (shared with cancel cascade)
      ]);
      return { run, timeline, children };
    }
    // Summarized: the children come from the timeline already loaded, rather than a second read of
    // every child-edge checkpoint (one per child of a wide fan). A child whose waiter is written but
    // whose placeholder checkpoint is not yet is missing for that one read; the next one lists it.
    const full = await this.store.listCheckpoints(runId);
    const { timeline, fans } = summarizeTimeline(full, over);
    const ids = childIdsOf(full);
    return {
      run,
      timeline,
      children: ids.slice(0, SUMMARY_CHILD_LIMIT),
      fans,
      childCount: ids.length,
    };
  }

  getRun(runId: string): Promise<WorkflowRun | null> {
    return this.store.getRun(runId);
  }

  async getFanMembers(runId: string, group: string, query: FanPageQuery): Promise<FanPage | null> {
    if (!(await this.store.getRun(runId))) return null;
    return pageFan(await this.store.listCheckpoints(runId), group, query);
  }

  async listRuns(query: RunQuery): Promise<RunListItem[]> {
    const runs = await this.store.listRuns(query);
    // One read of the listed suspended runs' signal waiters resolves what each is parked on — signal
    // / webhook / child — with no per-run timeline fetch. A timer wait falls back to the run's own
    // `wakeAt`. Non-suspended (and remote-step-in-flight) runs carry no `waiting`.
    const waiterByRun = indexWaitersByRun(
      await listSignalWaitersOfRuns(
        this.store,
        runs.filter((run) => run.status === 'suspended').map((run) => run.id),
      ),
    );
    return runs.map((run) => {
      const waiting = resolveRunWaiting(run, waiterByRun);
      return waiting ? { ...run, waiting } : run;
    });
  }

  /**
   * The `(status, origin)` counts behind a console's chips, straight off the store's aggregate. The
   * console needs this precisely BECAUSE its list is paginated: the page bounds what is rendered,
   * these counts stay whole-set exact. A store with no aggregate falls back to counting a full
   * listing — correct, but the unbounded read this exists to avoid, so it is the last resort.
   */
  async runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    if (this.store.runFacets) return this.store.runFacets(query);
    const runs = await this.store.listRuns(query);
    return mergeRunFacetRows(runs.map((r) => ({ status: r.status, origin: r.origin, count: 1 })));
  }

  /**
   * The distinct values behind a console's pickers, straight off the store's enumeration. A store
   * without one answers `[]` rather than falling back to a listing: unlike the facet counts above —
   * where a full listing is at least the RIGHT answer expensively — a picker built from an unbounded
   * scan would be the same unbounded read on every keystroke, for a control whose free-text entry
   * still works without it.
   */
  async runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    return this.store.runValueFacets?.(axis, query, opts) ?? [];
  }

  /**
   * Bulk-resolve what each of `runIds` is currently parked on — for a consumer with its own filtered/
   * paginated run listing (e.g. "which of MY suspended runs are stuck at a breakpoint") without
   * re-deriving `listRuns`' waiter read or querying `durable_step_checkpoints` directly. Mirrors
   * `listRuns`' waiting computation (the requested runs' signal waiters + `resolveRunWaiting`), but ALSO
   * bulk-fetches the currently-suspended runs to check real status: `engine.cancel` (the non-compensate
   * path) doesn't clear a run's signal waiter row, so a cancelled run can leave an ORPHANED waiter
   * behind — trusting waiter presence alone would wrongly report a terminal run as still waiting.
   * Two bulk reads total (never one query per requested id), same as `listRuns`.
   */
  async waitingFor(runIds: string[]): Promise<Record<string, RunWaiting>> {
    if (runIds.length === 0) return {};
    const idSet = new Set(runIds);
    const [suspended, waiters] = await Promise.all([
      this.store.listRuns({ statuses: ['suspended'] }),
      listSignalWaitersOfRuns(this.store, runIds),
    ]);
    const waiterByRun = indexWaitersByRun(waiters);
    const result: Record<string, RunWaiting> = {};
    for (const run of suspended) {
      if (!idSet.has(run.id)) continue;
      const waiting = resolveRunWaiting(run, waiterByRun);
      if (waiting) result[run.id] = waiting;
    }
    return result;
  }

  /** Every group the engine knows about — unscoped. A tenant proxy's request is scoped by the
   *  `RunRequestResponder` (to the requester's `@<tenant>` groups); the operator's own UI sees all. */
  workerHealth(): Promise<GroupHealth[]> {
    return this.engine.workerHealth();
  }

  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return this.engine.cancel(runId, opts);
  }

  /** Re-enqueue (dispatch model) instead of resuming inline — a worker picks the run up and replays it. */
  retry(runId: string): Promise<RunResult | null> {
    return this.engine.requeue(runId);
  }

  continue(runId: string): Promise<RunResult | null> {
    return this.engine.continue(runId);
  }

  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    return this.engine.retryWithInput(runId, input);
  }

  redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null> {
    return this.engine.redispatchPending(runId);
  }

  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    return this.engine.subscribe((event) => {
      if (event.runId === runId) onEvent(event);
    });
  }
}
