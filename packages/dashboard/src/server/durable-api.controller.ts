import { ApplyFilter, ApplyFilterInterceptor, FilterRunner } from '@dudousxd/nestjs-filter';
import {
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Query,
  Sse,
  UseInterceptors,
} from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';
import { DurableRun } from './durable-run.js';
import { type RunListRow, toRunListRow } from './run-list-row.js';
import type { RunQueryDraft } from './run-query-draft.js';
import { RunFilter } from './run.filter.js';

/**
 * JSON API consumed by the control-plane SPA. Mounted at `apiBasePath` (set by RouterModule).
 *
 * The filter interceptor (what resolves `@ApplyFilter` into a query) is bound HERE rather than as
 * the app-wide `APP_INTERCEPTOR` that `FilterModule.forRoot()` registers: a library must not add a
 * global interceptor to its host, and on an app that already has one this would be the second copy,
 * running every filter in the app twice.
 */
@Controller()
@UseInterceptors(ApplyFilterInterceptor)
export class DurableApiController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly runner: FilterRunner,
  ) {}

  /**
   * The run list, filtered by whatever the operator asked for.
   *
   * The predicates are parsed, validated and translated by `@dudousxd/nestjs-filter` (see
   * `RunFilter` for the two spellings it accepts, and `RunQueryAdapter` for how they become a
   * `RunQuery`). Every predicate is OPTIONAL and an omitted one means "don't narrow on this axis" —
   * in particular `namespace`, whose absence keeps the historical, deliberate behaviour that read
   * paths are NOT namespace-scoped (core, `WorkflowRun.namespace`): the console shows every tenant's
   * runs until an operator chooses one.
   */
  @Get('runs')
  async runs(@ApplyFilter(RunFilter) draft: RunQueryDraft): Promise<RunListRow[]> {
    const runs = await this.dashboard.listRuns(draft.query);
    // Rows only — the three payload fields are the bulk of a large listing and belong to `runs/:id`.
    return runs.map(toRunListRow);
  }

  /**
   * `(status, origin)` counts for the runs matching the same tag/tenant/attribute predicates as
   * `GET runs`. This is what lets that listing be PAGED at all: the page bounds what the console
   * renders, this bounds nothing and keeps its status and origin chips exact.
   *
   * `status`, `origin` and the page bounds are accepted (the route takes the same filter) but
   * deliberately DROPPED before counting — they are the axes being counted, so narrowing by them
   * would report the answer back to itself.
   */
  @Get('runs/facets')
  facets(@ApplyFilter(RunFilter) draft: RunQueryDraft) {
    return this.dashboard.runFacets(draft.facetQuery());
  }

  /**
   * The distinct values one filter field takes across the runs matching every OTHER active
   * predicate, with counts — what the console's tenant/tag/attribute pickers list.
   *
   * `?groupByCount[field]=tag&groupByCount[limit]=20`, with the filters in the structured
   * `filter[where][...]` form (what `filterQuery()` builds). Scoping the values to the active
   * filters is the point: picking a tenant leaves the tag picker offering only that tenant's tags,
   * so a picker never offers a value whose result set is empty.
   *
   * `limit` matters rather than being a nicety — tag and attribute cardinality grows with the data
   * (a `singleton:<key>` tag is minted per key), so the unbounded answer is a listing. `offset` and
   * `search` are what make that bound livable: a picker pages as it scrolls and narrows as the
   * operator types, both server-side, so a value outside the first page is still reachable.
   */
  @Get('runs/values')
  values(@Query() query: Record<string, unknown>) {
    return this.runner.groupByCount(DurableRun, query, { filterClass: RunFilter });
  }

  /** Prometheus-text metrics (runs/steps by outcome, per-workflow counts) for a scrape. */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics() {
    return this.dashboard.metrics();
  }

  /** Per-group worker health (queue backlog + live worker heartbeats) for the Workers panel. */
  @Get('workers')
  workers() {
    return this.dashboard.workerHealth();
  }

  /** This deployment's durable role (control plane vs tenant) + tenant name — for the header badge. */
  @Get('topology')
  topology() {
    return this.dashboard.topology();
  }

  @Get('runs/:id')
  async run(@Param('id') id: string) {
    const detail = await this.dashboard.getRunDetail(id);
    if (!detail) throw new NotFoundException(`run ${id} not found`);
    return detail;
  }

  /** Server-Sent Events stream of a run's live lifecycle events — the dashboard tails it instead
   *  of polling. Cross-pod when the transport has a control plane (see DashboardService.streamRun). */
  @Sse('runs/:id/stream')
  stream(@Param('id') id: string) {
    return this.dashboard.streamRun(id);
  }

  @Post('runs/:id/retry')
  retry(@Param('id') id: string) {
    return this.dashboard.retry(id);
  }

  /** Fix-and-replay: re-run a dead/failed run with a corrected input (a fresh linked run). */
  @Post('runs/:id/retry-with-input')
  retryWithInput(@Param('id') id: string, @Body() body: { input: unknown }) {
    return this.dashboard.retryWithInput(id, body?.input);
  }

  /**
   * Bulk retry/cancel every run matching a filter (status / tag / workflow / namespace / origin).
   * The filter takes the SAME params as `GET runs` and is parsed identically, so "retry all" acts on
   * exactly the set the operator was looking at rather than a wider one.
   */
  @Post('bulk/:action')
  bulk(
    @Param('action') action: 'retry' | 'cancel',
    @ApplyFilter(RunFilter) draft: RunQueryDraft,
    @Query('compensate') compensate?: string,
  ) {
    // The operator's page window is dropped, and only it: `bulk` acts on the whole matching SET (it
    // applies its own bound), so carrying a `limit` of 100 over from the list would silently retry
    // the first page and report success for the rest.
    const { limit, offset, ...filter } = draft.query;
    return this.dashboard.bulk(action === 'cancel' ? 'cancel' : 'retry', filter, {
      compensate: compensate === 'true',
    });
  }

  @Post('runs/:id/cancel')
  async cancel(@Param('id') id: string, @Query('compensate') compensate?: string) {
    const result = await this.dashboard.cancel(id, { compensate: compensate === 'true' });
    if (!result) throw new NotFoundException(`run ${id} not found`);
    return result;
  }

  @Post('runs/:id/continue')
  async continue(@Param('id') id: string) {
    const result = await this.dashboard.continue(id);
    if (!result) throw new NotFoundException(`run ${id} is not paused at a breakpoint`);
    return result;
  }

  /** Re-dispatch a run's stuck `pending` remote steps — recovery for a lost step dispatch. */
  @Post('runs/:id/redispatch')
  async redispatch(@Param('id') id: string) {
    const result = await this.dashboard.redispatch(id);
    if (!result) throw new NotFoundException(`run ${id} not found`);
    return result;
  }

  /**
   * Public callback endpoint for `ctx.webhook()`: a third party POSTs here (the url handed to it),
   * and the body resumes the waiting run. NOTE: this is reachable by external systems — protect it
   * by treating the token as a secret (it embeds runId:seq) and/or fronting it with signature
   * verification in your own middleware.
   */
  @Post('webhooks/:token')
  async webhook(@Param('token') token: string, @Body() body: unknown) {
    const result = await this.dashboard.deliverWebhook(token, body);
    if (!result) throw new NotFoundException(`no run is waiting on webhook ${token}`);
    return result;
  }

  /** Live query: the latest value a run published for `key` via `ctx.setEvent` (no side effect). */
  @Get('runs/:id/events/:key')
  event(@Param('id') id: string, @Param('key') key: string) {
    return this.dashboard.getEvent(id, key);
  }

  /** Deliver a validated `ctx.onUpdate` to a run; the body is the update argument. */
  @Post('runs/:id/updates/:name')
  update(@Param('id') id: string, @Param('name') name: string, @Body() body: unknown) {
    return this.dashboard.update(id, name, body);
  }
}
