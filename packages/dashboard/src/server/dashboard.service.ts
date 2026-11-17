import {
  type DurableTopology,
  type EngineEvent,
  type FanPage,
  type FanPageQuery,
  type GroupHealth,
  type MetricsCollector,
  type RepublishLifecycleResult,
  type RunDetail,
  type RunDetailOptions,
  type RunFacetQuery,
  type RunFacetRow,
  RunGateway,
  type RunListItem,
  type RunQuery,
  type RunResult,
  type RunValueAxis,
  type RunValueFacetOptions,
  type RunValueFacetRow,
  STATE_STORE_CANONICAL,
  type ScheduleDescription,
  type ScheduleListQuery,
  type StateStore,
  TERMINAL_RUN_STATUSES,
  type UpdateResult,
  WorkflowEngine,
  type WorkflowLifecycleLinks,
  collectMetrics,
  parseWebhookToken,
} from '@dudousxd/nestjs-durable-core';
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  Optional,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { appScopedGateway, currentConsoleApps, namespaceInApps } from './app-scope.js';
import {
  DASHBOARD_FEDERATION,
  type DurableConsoleFederation,
  currentFederatedApp,
  describeFederation,
  federatedGrant,
} from './federation.js';
import { listRunsAndCount } from './run-query.adapter.js';

// Single source of truth: core owns `RunDetail` (`run-gateway.ts`) — re-exported here (not
// re-declared) so this package's existing public API (`import type { RunDetail } from
// '@dudousxd/nestjs-durable-dashboard'`) keeps working unchanged.
export type { RunDetail };

/**
 * Read-model and actions backing the control-plane UI. Run-facing ops (list/detail/retry/cancel/
 * continue/retryWithInput/stream/bulk/workerHealth) route through the injected {@link RunGateway}
 * port, which the lib binds on both topologies (a store-backed impl on the control plane, a proxy
 * over the transport on a store-less tenant) — so those ops work regardless of whether `store`/
 * `engine` are present (`workerHealth` is scoped to the tenant's own groups over the proxy).
 * Operator-only ops (metrics/deliverWebhook/getEvent/update) still need direct `store`/`engine`
 * access; they stay `@Optional()` and throw a clear error when absent.
 */
/**
 * A workflow's lifecycle links as `GET workflows/:name/lifecycle` answers them, plus `triggerCounts`:
 * per subscriber of `startsOnSettle`, how many runs it was started for (`triggered`) and how many
 * times starting it failed (`failed`), counted by this process's metrics since it started.
 */
export interface WorkflowLifecyclePage extends WorkflowLifecycleLinks {
  triggerCounts?: Record<string, { triggered: number; failed: number }> | undefined;
}

@Injectable()
export class DashboardService {
  /** Prometheus counters accumulated from engine events since boot (per process); undefined on a
   *  store-less tenant (no engine to accumulate from). */
  private readonly metricsCollector: MetricsCollector | undefined;

  constructor(
    private readonly gateway: RunGateway,
    @Optional() @Inject(STATE_STORE_CANONICAL) private readonly store?: StateStore,
    @Optional() private readonly engine?: WorkflowEngine,
    @Optional()
    @Inject(DASHBOARD_FEDERATION)
    private readonly federation?: DurableConsoleFederation | null,
  ) {
    // Only the control plane (which has the canonical store) has a FULL engine to accumulate from;
    // on a tenant `this.engine` is a store-less start client with no `subscribe`, so guard on store.
    this.metricsCollector = this.store && this.engine ? collectMetrics(this.engine) : undefined;
  }

  /**
   * The run gateway for this request: confined to the viewer's apps when `authorize` granted a list
   * (see `ConsoleAppGrant`), the whole gateway otherwise.
   */
  private gw(): RunGateway {
    // A federated app's gateway: the viewer's grant already admitted the whole app.
    const federated = currentFederatedApp();
    if (federated) return federated.gateway;
    const apps = currentConsoleApps();
    return apps ? appScopedGateway(this.gateway, apps) : this.gateway;
  }

  /** A confined viewer may act on `runId` only when it is one of its apps' runs: else a 404. */
  private async assertRunVisible(runId: string): Promise<void> {
    if (currentConsoleApps() === undefined) return;
    if (!(await this.runExists(runId))) throw new NotFoundException(`run ${runId} not found`);
  }

  /** A confined viewer may touch schedule `id` only when it is in one of its apps: else a 404. */
  private async assertScheduleVisible(id: string): Promise<void> {
    if (currentFederatedApp()) return; // the app's own gateway answers a missing schedule
    const apps = currentConsoleApps();
    if (apps === undefined) return;
    const schedule = await this.engine?.schedules?.get(id);
    if (!schedule || !namespaceInApps(schedule.namespace, apps)) {
      throw Object.assign(new Error(`schedule "${id}" not found`), {
        name: 'ScheduleNotFoundError',
      });
    }
  }

  /**
   * The operator-only ops need the FULL engine + canonical store, which only the control plane has.
   * On a tenant the `WorkflowEngine` token is a store-less start client that implements none of these
   * methods, so presence of the canonical store is the reliable discriminator — gate on it (never
   * on engine presence, which is truthy on a tenant too).
   */
  private controlPlane(): { store: StateStore; engine: WorkflowEngine } {
    const federated = currentFederatedApp();
    if (federated) {
      // The console's own engine never acts on another app's runs.
      throw new NotImplementedException(
        `This durable dashboard operation is not available for the federated app "${federated.name}".`,
      );
    }
    if (!this.store || !this.engine) {
      // A 501, not a 500: a tenant is a supported deployment that simply doesn't serve this
      // operation (a third-party webhook POSTed to a tenant must go to the control plane).
      throw new NotImplementedException(
        'This durable dashboard operation requires the control plane (not available on a tenant deployment).',
      );
    }
    return { store: this.store, engine: this.engine };
  }

  /**
   * The persisted schedules (`engine.schedules`), soonest-due first. Empty — not an error — on a
   * tenant deployment or a store that doesn't persist schedules, so the console can simply hide the
   * panel instead of special-casing either.
   */
  async listSchedules(query: ScheduleListQuery): Promise<ScheduleDescription[]> {
    const federated = currentFederatedApp();
    if (federated) return (await federated.gateway.listSchedules?.(query)) ?? [];
    if (!this.store || !this.engine?.schedules?.supported) return [];
    const apps = currentConsoleApps();
    if (apps === undefined) return this.engine.schedules.list(query);
    // A confined viewer sees its apps' schedules only.
    if (query.namespace !== undefined && !apps.includes(query.namespace)) return [];
    const lists = await Promise.all(
      (query.namespace !== undefined ? [query.namespace] : apps).map((namespace) =>
        this.engine?.schedules.list({ ...query, namespace }),
      ),
    );
    const merged = lists.flat().filter((s): s is ScheduleDescription => s !== undefined);
    merged.sort(
      (a, b) =>
        (a.nextFireAt?.getTime() ?? Number.POSITIVE_INFINITY) -
        (b.nextFireAt?.getTime() ?? Number.POSITIVE_INFINITY),
    );
    return query.limit !== undefined ? merged.slice(0, query.limit) : merged;
  }

  /** Pause a persisted schedule (control plane only). */
  pauseSchedule(id: string): Promise<ScheduleDescription> {
    const federated = this.federatedSchedules();
    if (federated) return federated(id, 'pause') as Promise<ScheduleDescription>;
    // Synchronous on a tenant: the 501 is thrown, not rejected.
    const { engine } = this.controlPlane();
    return this.assertScheduleVisible(id).then(() => engine.schedules.pause(id));
  }

  /** Resume a persisted schedule from its next window (control plane only). */
  resumeSchedule(id: string): Promise<ScheduleDescription> {
    const federated = this.federatedSchedules();
    if (federated) return federated(id, 'resume') as Promise<ScheduleDescription>;
    // Synchronous on a tenant: the 501 is thrown, not rejected.
    const { engine } = this.controlPlane();
    return this.assertScheduleVisible(id).then(() => engine.schedules.resume(id));
  }

  /** Start one run of a persisted schedule now, outside its cadence (control plane only). */
  triggerSchedule(id: string): Promise<RunResult> {
    const federated = this.federatedSchedules();
    if (federated) return federated(id, 'trigger') as Promise<RunResult>;
    // Synchronous on a tenant: the 501 is thrown, not rejected.
    const { engine } = this.controlPlane();
    return this.assertScheduleVisible(id).then(() => engine.schedules.trigger(id));
  }

  /** The federated app's schedule actions, when the request is for one (else undefined). */
  private federatedSchedules():
    | ((id: string, action: 'pause' | 'resume' | 'trigger') => Promise<unknown>)
    | undefined {
    const federated = currentFederatedApp();
    if (!federated) return undefined;
    const { gateway } = federated;
    if (!gateway.scheduleAction) {
      throw new NotImplementedException(
        `The federated app "${federated.name}" does not serve schedule actions.`,
      );
    }
    return (id, action) => gateway.scheduleAction?.(id, action) as Promise<unknown>;
  }

  /**
   * Prometheus-text metrics for a `/metrics` scrape: the event-counters (runs/steps by outcome,
   * per-workflow counts) plus live **backlog gauges** queried at scrape time — `durable_pending_runs`
   * (the dispatch backlog: the key health signal of the dispatch model) and `durable_dead_runs` (DLQ
   * size). Capped per status so the scrape can't load an unbounded result set. Control-plane-only.
   */
  async metrics(): Promise<string> {
    const { store, engine } = this.controlPlane();
    // The counters and gauges span every app: only a viewer who sees them all gets them.
    if (currentConsoleApps() !== undefined) {
      throw new ForbiddenException('metrics cover every app; your console grant names only some');
    }
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

  listRuns(query: RunQuery): Promise<RunListItem[]> {
    return this.gw().listRuns(query);
  }

  /** One page of runs (`query.limit`/`offset`) and how many runs match `query` across every page. */
  listRunsPage(query: RunQuery): Promise<{ rows: RunListItem[]; total: number }> {
    return listRunsAndCount(this.gw(), query);
  }

  /** `(status, origin)` counts over the same predicates {@link listRuns} pages — what keeps the
   *  console's chips exact while its list is bounded to a page. */
  runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    return this.gw().runFacets(query);
  }

  /** The distinct values of one filter axis over the same predicates — what fills the console's
   *  tenant/tag/attribute pickers, so an operator picks a value that exists instead of typing one
   *  blind. `[]` when the store cannot enumerate them; the pickers then fall back to free text. */
  runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    return this.gw().runValueFacets(axis, query, opts);
  }

  /** This deployment's durable role (control plane vs tenant) + tenant name — for the dashboard header
   *  badge. Routes through the gateway, which knows its own topology (store-backed = operator, proxy =
   *  tenant). Works on both topologies (no store/engine needed). */
  topology(): DurableTopology {
    const topology = this.gw().topology();
    if (!this.federation) return topology;
    const federated = currentFederatedApp();
    const grant = federated ? federatedGrant() : currentConsoleApps();
    return {
      ...topology,
      federation: describeFederation(this.federation, grant, federated?.name),
    };
  }

  /** Per-group worker health (queue backlog + live worker heartbeats) for the Workers panel. The
   *  alert state a row turns red on is `depth > 0 && liveWorkers.length === 0`. Routes through the
   *  gateway so it works on BOTH topologies: the control plane returns every group; a tenant proxies
   *  to the operator, which scopes the result to the tenant's own `@<tenant>` groups. */
  async workerHealth(): Promise<GroupHealth[]> {
    return this.gw().workerHealth();
  }

  getRunDetail(runId: string, options?: RunDetailOptions): Promise<RunDetail | null> {
    return this.gw().getRunDetail(runId, options);
  }

  /** A page of one fan's members, or null when the run is unknown or the gateway can't page fans. */
  async getFanMembers(runId: string, group: string, query: FanPageQuery): Promise<FanPage | null> {
    return (await this.gw().getFanMembers?.(runId, group, query)) ?? null;
  }

  /** Fix-and-replay a dead/failed run with a corrected input — a fresh linked run. Returns its id. */
  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    return this.gw().retryWithInput(runId, input);
  }

  /** Re-run a failed/incomplete run; completed steps replay from their checkpoints. */
  retry(runId: string): Promise<RunResult | null> {
    return this.gw().retry(runId);
  }

  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return this.gw().cancel(runId, opts);
  }

  /**
   * Publish a settled run's lifecycle event again, to its subscribers that have not started (or to
   * `subscriber` alone). Undefined when the gateway cannot republish (a tenant proxy).
   */
  async republishLifecycle(
    runId: string,
    subscriber?: string,
  ): Promise<RepublishLifecycleResult | undefined> {
    return this.gw().republishLifecycle?.({
      runId,
      ...(subscriber !== undefined ? { subscriber } : {}),
    });
  }

  /**
   * Who starts whom through lifecycle events, for `workflow`, plus `triggerCounts` when this process
   * counts the engine's events (the control plane) and the workflow has subscribers. Undefined when
   * the gateway cannot answer.
   */
  async workflowLifecycle(workflow: string): Promise<WorkflowLifecyclePage | undefined> {
    const links = await this.gw().workflowLifecycle?.(workflow);
    if (!links) return links;
    const counts = this.triggerCountsOf(links);
    return counts ? { ...links, triggerCounts: counts } : links;
  }

  /**
   * How many runs each subscriber of `links.workflow` was started for and how many times starting it
   * failed, counted by this process's metrics since it started. Undefined without metrics (a tenant)
   * or without subscribers.
   */
  private triggerCountsOf(
    links: WorkflowLifecycleLinks,
  ): Record<string, { triggered: number; failed: number }> | undefined {
    // Process-wide counters span every app, and count this process's engine only.
    if (currentConsoleApps() !== undefined || currentFederatedApp()) return undefined;
    const snapshot = this.metricsCollector?.snapshot();
    if (!snapshot || links.startsOnSettle.length === 0) return undefined;
    const triggered = snapshot.triggeredBySubscriber[links.workflow] ?? {};
    const failed = snapshot.triggerFailedBySubscriber[links.workflow] ?? {};
    const counts: Record<string, { triggered: number; failed: number }> = {};
    for (const { workflow } of links.startsOnSettle) {
      counts[workflow] = { triggered: triggered[workflow] ?? 0, failed: failed[workflow] ?? 0 };
    }
    return counts;
  }

  /**
   * Apply `retry` or `cancel` to every run matching a filter (status / tag / workflow / namespace /
   * origin) — e.g. "retry every `dead` run tagged `type:mel`". The filter is the same one the run
   * list uses, so a bulk action can never reach wider than the list it was launched from — but note
   * an ABSENT predicate still means "every value on that axis" (an omitted `namespace` is every
   * tenant), which is what makes passing the operator's full filter through mandatory, not optional.
   * Capped at 500 runs per call; runs that can't be acted on
   * (already terminal) are skipped. Returns how many matched and how many the action applied to.
   */
  async bulk(
    action: 'retry' | 'cancel',
    filter: Pick<RunQuery, 'status' | 'tag' | 'workflow' | 'attributes' | 'namespace' | 'origin'>,
    opts?: { compensate?: boolean },
  ): Promise<{ matched: number; applied: number }> {
    const runs = await this.gw().listRuns({ ...filter, limit: 500 });
    let applied = 0;
    for (const r of runs) {
      try {
        if (action === 'retry') await this.gw().retry(r.id);
        else await this.gw().cancel(r.id, opts);
        applied += 1;
      } catch {
        // Skip a run that can't take the action (e.g. already terminal) — keep going.
      }
    }
    return { matched: runs.length, applied };
  }

  /** Resume a run paused at a `ctx.breakpoint` (the "continue" button). */
  continue(runId: string): Promise<RunResult | null> {
    return this.gw().continue(runId);
  }

  /** Re-dispatch a run's stuck `pending` remote steps — recovery for a lost step dispatch. */
  redispatch(runId: string) {
    return this.gw().redispatchPending(runId);
  }

  /**
   * Deliver a `ctx.webhook()` callback: turn an inbound POST (token + body) into the signal the
   * run is (or will be) parked on. A callback that arrives BEFORE the run reaches `wait()` (the url
   * was handed out and the run is still busy or sleeping) is buffered, and `wait()` consumes it, so
   * the result is the run's current status. Returns `null` — mapped to 404 by the controller — for a
   * token that is not a webhook token, whose run doesn't exist or is terminal, or whose wait already
   * resolved (a duplicate): nothing is buffered for those, so a public endpoint can't leave junk
   * rows behind or signal non-webhook tokens. Control-plane-only.
   */
  async deliverWebhook(token: string, body: unknown): Promise<RunResult | null> {
    const { store, engine } = this.controlPlane();
    const parsed = parseWebhookToken(token);
    if (!parsed) return null;
    const run = await store.getRun(parsed.runId);
    if (!run || TERMINAL_RUN_STATUSES.includes(run.status)) return null;
    const resolved = await store.getCheckpoint(parsed.runId, parsed.seq);
    if (resolved?.status === 'completed') return null;
    const delivered = await engine.signal(token, body);
    if (delivered) return delivered;
    // Buffered. A concurrent duplicate may have resolved the wait between the check above and our
    // buffer write: then nothing will ever read this row, so take it back and answer 404. (If the
    // take finds nothing, the waiter consumed our payload itself — a real delivery.)
    const now = await store.getCheckpoint(parsed.runId, parsed.seq);
    if (now?.status === 'completed' && (await store.takeBufferedSignal(token))) return null;
    const fresh = await store.getRun(parsed.runId);
    return { runId: run.id, status: fresh?.status ?? run.status };
  }

  /**
   * What this deployment can serve: `controlPlane` (signals, run events, updates, metrics) and
   * `schedules` (persisted schedules). Both are false on a store-less tenant.
   */
  capabilities(): { controlPlane: boolean; schedules: boolean } {
    const federated = currentFederatedApp();
    if (federated) {
      return { controlPlane: false, schedules: federated.gateway.listSchedules !== undefined };
    }
    const controlPlane = this.store !== undefined && this.engine !== undefined;
    return { controlPlane, schedules: controlPlane && this.engine?.schedules?.supported === true };
  }

  /** A run's id, workflow and status, or null when no run the caller may see has that id. */
  async findRun(runId: string): Promise<{ id: string; workflow: string; status: string } | null> {
    const gateway = this.gw();
    const run = gateway.getRun
      ? await gateway.getRun(runId)
      : (await gateway.getRunDetail(runId, { summarizeFansOver: 0 }))?.run;
    return run ? { id: run.id, workflow: run.workflow, status: run.status } : null;
  }

  /** Whether `runId` names a run the caller may see (tenancy applies). */
  async runExists(runId: string): Promise<boolean> {
    const gateway = this.gw();
    if (gateway.getRun) return (await gateway.getRun(runId)) !== null;
    return (await gateway.getRunDetail(runId, { summarizeFansOver: 0 })) !== null;
  }

  /**
   * Deliver `payload` to the run waiting on `token` (`engine.signal`). Null when no run the caller
   * may see waits on it yet: the engine then buffers the payload for the run that waits next.
   * Control-plane-only.
   */
  signal(token: string, payload: unknown): Promise<RunResult | null> {
    const federated = currentFederatedApp();
    if (federated) {
      if (!federated.gateway.signal) {
        throw new NotImplementedException(
          `The federated app "${federated.name}" does not serve signals.`,
        );
      }
      return federated.gateway.signal(token, payload);
    }
    return this.controlPlane().engine.signal(token, payload);
  }

  /** Side-effect-free read of a value a run published via `ctx.setEvent` (a live query). Control-plane-only. */
  async getEvent(runId: string, key: string): Promise<unknown> {
    const { engine } = this.controlPlane();
    await this.assertRunVisible(runId);
    return engine.getEvent(runId, key);
  }

  /** Deliver a validated `ctx.onUpdate` to a run; the validator may reject it (see UpdateResult). Control-plane-only. */
  async update(runId: string, name: string, arg: unknown): Promise<UpdateResult> {
    const { engine } = this.controlPlane();
    await this.assertRunVisible(runId);
    return engine.update(runId, name, arg);
  }

  /**
   * Live stream of a run's lifecycle events for SSE. Backed by `gateway.subscribe`, which — on the
   * control plane — receives events from EVERY instance (so a dashboard-only pod tails a run
   * executing on a worker pod), and on a tenant round-trips over the transport. Either way the
   * gateway already filters to `runId`; the dashboard just wires the events through.
   */
  streamRun(runId: string): Observable<{ data: EngineEvent }> {
    // Captured now: the stream is subscribed after the handler returns, outside the request scope.
    const gateway = this.gw();
    if (currentConsoleApps() === undefined) {
      return new Observable<{ data: EngineEvent }>((subscriber) => {
        const off = gateway.subscribe(runId, (event) => subscriber.next({ data: event }));
        return () => off();
      });
    }
    // A run outside the viewer's apps streams nothing: answered like an unknown run.
    return new Observable<{ data: EngineEvent }>((subscriber) => {
      let off: (() => void) | undefined;
      let closed = false;
      // `gateway` is the app-scoped one here, whose `getRun` is always defined (it falls back to
      // `getRunDetail` on a gateway without one).
      const lookup = gateway.getRun
        ? gateway.getRun(runId)
        : gateway.getRunDetail(runId, { summarizeFansOver: 0 }).then((d) => d?.run ?? null);
      void lookup.then(
        (run) => {
          if (closed) return;
          if (!run) {
            subscriber.error(new NotFoundException(`run ${runId} not found`));
            return;
          }
          off = gateway.subscribe(runId, (event) => subscriber.next({ data: event }));
        },
        (error: unknown) => subscriber.error(error),
      );
      return () => {
        closed = true;
        off?.();
      };
    });
  }
}
