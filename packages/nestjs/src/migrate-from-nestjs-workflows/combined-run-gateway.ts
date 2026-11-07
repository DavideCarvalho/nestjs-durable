import {
  type DurableTopology,
  type EngineEvent,
  type GroupHealth,
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
  type RunWaiting,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';

/**
 * One console over two engines during a cutover: `primary` (nestjs-durable) and `legacy` (the
 * official `@nestjs/workflows`, through `@dudousxd/nestjs-durable-workflows-gateway`). Lists and
 * counts merge both; everything addressed by a run id goes to whichever engine has that id, durable
 * first. The console shows every control (durable runs support them); one a legacy run can't serve
 * answers like a missing run.
 */
export class CombinedRunGateway extends RunGateway {
  private readonly primary: RunGateway;
  private readonly legacy: RunGateway;
  // Durable-only features (lifecycle events, fan paging): the primary's, when it has them.
  override getFanMembers?: NonNullable<RunGateway['getFanMembers']>;
  override republishLifecycle?: NonNullable<RunGateway['republishLifecycle']>;
  override workflowLifecycle?: NonNullable<RunGateway['workflowLifecycle']>;
  override lifecycleSubscribers?: NonNullable<RunGateway['lifecycleSubscribers']>;

  constructor(primary: RunGateway, legacy: RunGateway) {
    super();
    this.primary = primary;
    this.legacy = legacy;
    if (primary.getFanMembers) this.getFanMembers = primary.getFanMembers.bind(primary);
    if (primary.republishLifecycle)
      this.republishLifecycle = primary.republishLifecycle.bind(primary);
    if (primary.workflowLifecycle) this.workflowLifecycle = primary.workflowLifecycle.bind(primary);
    if (primary.lifecycleSubscribers) {
      this.lifecycleSubscribers = primary.lifecycleSubscribers.bind(primary);
    }
  }

  topology(): DurableTopology {
    return { ...this.primary.topology(), engine: 'nestjs-durable + @nestjs/workflows' };
  }

  /** The gateway that has `runId`, durable first; `undefined` when neither does. */
  private async owner(runId: string): Promise<RunGateway | undefined> {
    for (const gateway of [this.primary, this.legacy]) {
      const run = gateway.getRun
        ? await gateway.getRun(runId)
        : (await gateway.getRunDetail(runId))?.run;
      if (run) return gateway;
    }
    return undefined;
  }

  override async getRun(runId: string): Promise<WorkflowRun | null> {
    return (
      (await this.primary.getRun?.(runId)) ??
      (await this.legacy.getRun?.(runId)) ??
      (await this.getRunDetail(runId))?.run ??
      null
    );
  }

  async getRunDetail(runId: string, options?: RunDetailOptions): Promise<RunDetail | null> {
    return (
      (await this.primary.getRunDetail(runId, options)) ?? this.legacy.getRunDetail(runId, options)
    );
  }

  /** Both lists, newest first, then the page. */
  async listRuns(query: RunQuery): Promise<RunListItem[]> {
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    const window = { ...query, offset: 0, limit: offset + limit };
    const [a, b] = await Promise.all([this.primary.listRuns(window), this.legacy.listRuns(window)]);
    return [...a, ...b]
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || y.id.localeCompare(x.id))
      .slice(offset, offset + limit);
  }

  async runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    const [a, b] = await Promise.all([this.primary.runFacets(query), this.legacy.runFacets(query)]);
    const cells = new Map<string, RunFacetRow>();
    for (const row of [...a, ...b]) {
      const key = `${row.status}\u0000${row.origin ?? ''}`;
      const cell = cells.get(key);
      if (cell) cell.count += row.count;
      else cells.set(key, { ...row });
    }
    return [...cells.values()];
  }

  async runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    const [a, b] = await Promise.all([
      this.primary.runValueFacets(axis, query, opts),
      this.legacy.runValueFacets(axis, query, opts),
    ]);
    const counts = new Map<string | null, number>();
    for (const row of [...a, ...b]) counts.set(row.value, (counts.get(row.value) ?? 0) + row.count);
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((x, y) => y.count - x.count);
  }

  async waitingFor(runIds: string[]): Promise<Record<string, RunWaiting>> {
    const [a, b] = await Promise.all([
      this.primary.waitingFor(runIds),
      this.legacy.waitingFor(runIds),
    ]);
    return { ...b, ...a };
  }

  workerHealth(): Promise<GroupHealth[]> {
    return this.primary.workerHealth();
  }

  async cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return (await this.owner(runId))?.cancel(runId, opts) ?? null;
  }

  async retry(runId: string): Promise<RunResult | null> {
    return (await this.owner(runId))?.retry(runId) ?? null;
  }

  async continue(runId: string): Promise<RunResult | null> {
    return (await this.owner(runId))?.continue(runId) ?? null;
  }

  async redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null> {
    return (await this.owner(runId))?.redispatchPending(runId) ?? null;
  }

  /** Replays on the engine that ran it (a legacy run's workflow may not exist on durable yet). */
  async retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    return (await this.owner(runId))?.retryWithInput(runId, input) ?? null;
  }

  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    const offs = [this.primary.subscribe(runId, onEvent), this.legacy.subscribe(runId, onEvent)];
    return () => {
      for (const off of offs) off();
    };
  }
}
