import {
  type DurableTopology,
  type EngineEvent,
  type FanPage,
  type FanPageQuery,
  type GroupHealth,
  LIFECYCLE_REGISTRY_WORKFLOW,
  type LifecycleDelivery,
  type LifecycleKind,
  type RepublishLifecycleResult,
  type RepublishLifecycleTarget,
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
  type RunWaitLink,
  type RunWaiting,
  STATE_STORE_CANONICAL,
  SUMMARY_CHILD_LIMIT,
  type StateStore,
  WorkflowEngine,
  type WorkflowLifecycleLinks,
  type WorkflowRun,
  aggregatesCheckpoints,
  childIdsOf,
  etagMatches,
  extendEtag,
  fanPageEtag,
  indexWaitersByRun,
  lifecycleDeliveriesOf,
  lifecycleKindOf,
  lifecycleSourceOf,
  lifecycleTraceparentOf,
  listSignalWaitersOfRuns,
  mergeRunFacetRows,
  pageFan,
  pageFanFromStore,
  readRunsByIds,
  resolveRunWaiting,
  runDetailEtag,
  runWaitPrefix,
  runWaitTargetOf,
  summarizeRunFromStore,
  summarizeTimeline,
  traceIdOfTraceparent,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable } from '@nestjs/common';

/**
 * What a run detail reads from outside the run row and its checkpoints, folded into its ETag: the
 * subscribers and where each delivery stands, and the status of every run its links point at.
 * Undefined when it has none of them.
 */
function detailExtras(
  links: Pick<
    RunDetail,
    'lifecycleSubscribers' | 'lifecycleDeliveries' | 'waitsFor' | 'awaitedBy' | 'triggeredBy'
  >,
): unknown {
  const { lifecycleSubscribers, lifecycleDeliveries, waitsFor, awaitedBy, triggeredBy } = links;
  if (!lifecycleSubscribers && !lifecycleDeliveries && !waitsFor && !awaitedBy && !triggeredBy) {
    return undefined;
  }
  return { lifecycleSubscribers, lifecycleDeliveries, waitsFor, awaitedBy, triggeredBy };
}

/**
 * `query` without the lifecycle registry's runs, engine bookkeeping that is not a run anyone
 * started, unless the query names that workflow itself.
 */
function withoutRegistry<Q extends RunFacetQuery>(query: Q): Q {
  if (
    query.workflow === LIFECYCLE_REGISTRY_WORKFLOW ||
    query.workflows?.includes(LIFECYCLE_REGISTRY_WORKFLOW)
  ) {
    return query;
  }
  return {
    ...query,
    excludeWorkflows: [...(query.excludeWorkflows ?? []), LIFECYCLE_REGISTRY_WORKFLOW],
  };
}

/**
 * Store-backed `RunGateway` — the operator-side implementation, bound to {@link RunGateway} on
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

  /**
   * Narrow `query` to the caller's tenant (the tenancy matching rule; see `DurableModule`'s
   * `tenancy`). A no-op with tenancy off, or for a caller outside any request (`system`).
   */
  private scoped<Q extends RunQuery | RunFacetQuery>(query: Q): Q {
    return typeof this.engine?.scopeRunQuery === 'function'
      ? (this.engine.scopeRunQuery(query as RunQuery) as Q)
      : query;
  }

  /** The run, or null when it is missing OR belongs to a tenant the caller may not see (404). */
  private async visibleRun(runId: string): Promise<WorkflowRun | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const { tenantIds } = this.scoped({} as RunQuery);
    return !tenantIds || tenantIds.includes(run.tenantId ?? null) ? run : null;
  }

  async getRunDetail(runId: string, options?: RunDetailOptions): Promise<RunDetail | null> {
    const run = await this.visibleRun(runId);
    if (!run) return null;
    const links = await this.lifecycleLinks(run);
    const over = options?.summarizeFansOver;
    if (over === undefined) {
      const [timeline, children] = await Promise.all([
        this.store.listCheckpoints(runId),
        this.engine.getRunChildren(runId), // canonical parent→children edge (shared with cancel cascade)
      ]);
      return { run, timeline, children, ...links };
    }
    // Summarized: the children come from the checkpoints, rather than from a read of every
    // child-edge checkpoint plus the waiters. A child whose waiter is written but whose placeholder
    // checkpoint is not yet is missing for that one read; the next one lists it.
    if (aggregatesCheckpoints(this.store)) {
      // The buckets are read before any row, so a write landing mid-read leaves the ETag older than
      // the body: the next poll misses and re-reads, rather than pinning a stale body.
      const stats = await this.store.checkpointStats(runId);
      const etag = extendEtag(runDetailEtag(run, stats, over), detailExtras(links));
      if (etagMatches(options?.ifNoneMatch, etag)) {
        return { run, timeline: [], children: [], notModified: true, etag };
      }
      return {
        run,
        ...(await summarizeRunFromStore(this.store, runId, over, stats)),
        etag,
        ...links,
      };
    }
    const full = await this.store.listCheckpoints(runId);
    const { timeline, fans } = summarizeTimeline(full, over);
    const ids = childIdsOf(full);
    return {
      run,
      timeline,
      children: ids.slice(0, SUMMARY_CHILD_LIMIT),
      fans,
      childCount: ids.length,
      ...links,
    };
  }

  /**
   * What a run detail reads beyond the run row and its checkpoints: what this run's settling
   * started, the subscribers its lifecycle event goes to (of its namespace) and where it stands for
   * each, what started it, its workflow's lifecycle links, and the `ctx.waitForRun` waits on either
   * side of it with the other run's status. A few reads per detail: the run's own waiters while it
   * is suspended, the waiters on it (one prefix read), and one batched read of every linked run.
   */
  private async lifecycleLinks(
    run: WorkflowRun,
  ): Promise<
    Pick<
      RunDetail,
      | 'triggered'
      | 'triggeredBy'
      | 'lifecycleSubscribers'
      | 'workflowLifecycle'
      | 'lifecycleDeliveries'
      | 'waitsFor'
      | 'awaitedBy'
    >
  > {
    const triggered = await this.engine.triggeredRuns(run);
    const source = lifecycleSourceOf(run);
    const kind = lifecycleKindOf(run.status);
    const subscribers = kind
      ? await this.engine.lifecycleSubscribers(run.workflow, kind, run.namespace || 'default')
      : [];
    const workflowLifecycle = await this.engine.workflowLifecycle(run.workflow);
    const linked =
      workflowLifecycle.startsOnSettle.length > 0 || workflowLifecycle.startedBy.length > 0;
    const deliveries = kind
      ? lifecycleDeliveriesOf(run, {
          subscribers,
          live: new Set(subscribers),
          coalesced: this.engine.coalescedSubscribers(run),
        })
      : [];
    const [own, onIt] = await Promise.all([
      run.status === 'suspended' ? listSignalWaitersOfRuns(this.store, [run.id]) : [],
      run.workflow.startsWith('__') ? [] : this.store.listSignalWaiters(runWaitPrefix(run.id)),
    ]);
    const waitsFor: RunWaitLink[] = own.flatMap((w) => {
      const target = runWaitTargetOf(w);
      return target !== undefined ? [{ runId: target, seq: w.seq }] : [];
    });
    const awaitedBy: RunWaitLink[] = onIt
      .filter((w) => runWaitTargetOf(w) === run.id)
      .map((w) => ({ runId: w.runId, seq: w.seq }));
    const started = deliveries.flatMap((d) =>
      d.state === 'started' && d.runId !== undefined ? [d.runId] : [],
    );
    const { runs } = await readRunsByIds(this.store, [
      ...(source ? [source.runId] : []),
      ...started,
      ...waitsFor.map((l) => l.runId),
      ...awaitedBy.map((l) => l.runId),
    ]);
    const withRun = <T extends { runId?: string | undefined }>(link: T): T => {
      const other = link.runId !== undefined ? runs.get(link.runId) : undefined;
      return other ? { ...link, status: other.status, namespace: other.namespace } : link;
    };
    const sourceRun = source ? runs.get(source.runId) : undefined;
    const traceId = traceIdOfTraceparent(lifecycleTraceparentOf(sourceRun?.tags));
    return {
      ...(triggered.length > 0 ? { triggered } : {}),
      ...(source
        ? {
            triggeredBy: {
              ...source,
              ...(sourceRun ? { status: sourceRun.status, namespace: sourceRun.namespace } : {}),
              ...(traceId ? { traceId } : {}),
            },
          }
        : {}),
      ...(subscribers.length > 0 ? { lifecycleSubscribers: subscribers } : {}),
      ...(linked ? { workflowLifecycle } : {}),
      ...(deliveries.length > 0
        ? {
            lifecycleDeliveries: deliveries.map(
              (d): LifecycleDelivery => (d.state === 'started' ? withRun(d) : d),
            ),
          }
        : {}),
      ...(waitsFor.length > 0 ? { waitsFor: waitsFor.map(withRun) } : {}),
      ...(awaitedBy.length > 0 ? { awaitedBy: awaitedBy.map(withRun) } : {}),
    };
  }

  workflowLifecycle(
    workflow: string,
    opts?: { namespace?: string | undefined },
  ): Promise<WorkflowLifecycleLinks> {
    return this.engine.workflowLifecycle(workflow, opts);
  }

  lifecycleSubscribers(
    workflow: string,
    kind: LifecycleKind,
    namespace: string,
  ): Promise<string[]> {
    return this.engine.lifecycleSubscribers(workflow, kind, namespace);
  }

  getRun(runId: string): Promise<WorkflowRun | null> {
    return this.visibleRun(runId);
  }

  async getFanMembers(runId: string, group: string, query: FanPageQuery): Promise<FanPage | null> {
    if (!(await this.visibleRun(runId))) return null;
    if (aggregatesCheckpoints(this.store)) {
      const stats = await this.store.checkpointStats(runId, { group });
      const etag = fanPageEtag(group, stats, query);
      if (etagMatches(query.ifNoneMatch, etag)) {
        return { items: [], total: 0, notModified: true, etag };
      }
      return { ...(await pageFanFromStore(this.store, runId, group, query, stats)), etag };
    }
    return pageFan(await this.store.listCheckpoints(runId), group, query);
  }

  async listRuns(query: RunQuery): Promise<RunListItem[]> {
    const runs = await this.store.listRuns(this.scoped(withoutRegistry(query)));
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
    const scoped = this.scoped(withoutRegistry(query));
    if (this.store.runFacets) return this.store.runFacets(scoped);
    const runs = await this.store.listRuns(scoped);
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
    return this.store.runValueFacets?.(axis, this.scoped(withoutRegistry(query)), opts) ?? [];
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
      this.store.listRuns(this.scoped({ statuses: ['suspended'] })),
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

  republishLifecycle(target: RepublishLifecycleTarget): Promise<RepublishLifecycleResult> {
    return this.engine.republishLifecycle(target);
  }

  /**
   * Stream `runId`'s events. With tenancy, a run the caller may not see streams nothing; events of a
   * run that does not exist yet are held until its row shows whose it is.
   */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    // Read the caller's tenant now: the events arrive outside its async context.
    const { tenantIds } = this.scoped({} as RunQuery);
    if (!tenantIds) {
      return this.engine.subscribe((event) => {
        if (event.runId === runId) onEvent(event);
      });
    }
    let visible: boolean | undefined; // undefined until the run's row has been read
    let held: EngineEvent[] = [];
    let checking = false;
    const check = (): void => {
      if (checking || visible !== undefined) return;
      checking = true;
      void this.store
        .getRun(runId)
        .then(
          (run) => {
            if (run) visible = tenantIds.includes(run.tenantId ?? null);
          },
          () => undefined,
        )
        .finally(() => {
          checking = false;
          if (visible === undefined) return;
          const pending = held;
          held = [];
          if (visible) for (const event of pending) onEvent(event);
        });
    };
    const off = this.engine.subscribe((event) => {
      if (event.runId !== runId || visible === false) return;
      if (visible) return onEvent(event);
      held.push(event);
      check();
    });
    check();
    return () => {
      held = [];
      off();
    };
  }
}
