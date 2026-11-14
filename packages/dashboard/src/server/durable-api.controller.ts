import { FilterRunner } from '@dudousxd/nestjs-filter';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  NotFoundException,
  NotImplementedException,
  Param,
  Post,
  Query,
  Res,
  Sse,
  UseFilters,
} from '@nestjs/common';
import { ConsolePublic } from './console-authorize.js';
import { DashboardService } from './dashboard.service.js';

/** Fans with more members than this come back summarized in a run's detail. */
const FAN_INLINE_MAX = 50;
/** Fan member pages: the default and the largest `size` (the store's own ceiling). */
const FAN_PAGE_SIZE = 100;
const FAN_PAGE_MAX = 500;
/** Schedules are a short top-N list (no count, no stable keyset): default and largest `size`. */
const SCHEDULES_SIZE = 200;
const SCHEDULES_MAX = 1_000;
import { DurableRun } from './durable-run.js';
import {
  ListQueryError,
  type OffsetPage,
  offsetPage,
  parseFilterParams,
  parsePageParams,
  rejectUnknownParams,
} from './list-api.js';
import { NotModifiedException, NotModifiedFilter, setEtag } from './not-modified.js';
import { runColumnFilters, runFilterInput, runPageParams } from './run-list-query.js';
import { type RunListRow, toRunListRow } from './run-list-row.js';
import { RunQueryDraft } from './run-query-draft.js';
import { RunFilter } from './run.filter.js';
import { withTenantLabels } from './tenant-labels.js';

/**
 * JSON API consumed by the control-plane SPA. The mounted {@link DurableApiController} sits at
 * `apiBasePath` (set by RouterModule).
 *
 * This base is what a host EXTENDS to serve the API from a controller of its own (with
 * `forRoot({ routes: false, apiBasePath })`): `@Controller('<apiBasePath>') class MyConsoleApi
 * extends DurableApiControllerBase {}`. It carries no guards and no `@nestjs/authorization` mark,
 * so a subclass is protected only by what the host puts on it.
 *
 * Every list route speaks Aviary's list wire: `filter[field]=v` / `filter[field][op]=v`, `page` +
 * `size` (offset) and `{ data, meta }` back, or `{ data }` for a short list. An unknown filter field,
 * an unsupported operator or a bad page param is a 400.
 */
@Controller()
@UseFilters(NotModifiedFilter)
export class DurableApiControllerBase {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly runner: FilterRunner,
  ) {}

  /**
   * The run list, filtered by whatever the operator asked for, newest first, one page at a time.
   *
   * `filter[...]` is translated by `runColumnFilters` and applied through `@dudousxd/nestjs-filter`'s
   * {@link RunFilter} (see `RunQueryAdapter` for how each clause becomes a `RunQuery` predicate).
   * Every predicate is OPTIONAL and an omitted one means "don't narrow on this axis" — in particular
   * `namespace`, whose absence keeps the historical, deliberate behaviour that read paths are NOT
   * namespace-scoped (core, `WorkflowRun.namespace`): the console shows every tenant's runs until an
   * operator chooses one.
   *
   * `page`/`size` (default 100, at most 500) window the list; `meta.total` counts the whole matching
   * set from the facet aggregate. `sort` accepts only `-createdAt`, the one order a run list has.
   */
  @Get('runs')
  async runs(@Query() query: Record<string, unknown> = {}): Promise<OffsetPage<RunListRow>> {
    rejectUnknownParams(query, ['page', 'size', 'sort', 'filter']);
    const { page, size, offset } = runPageParams(query);
    const draft = await this.runDraft(query);
    const { rows, total } = await this.dashboard.listRunsPage({
      ...draft.query,
      limit: size,
      offset,
    });
    // Rows only — the three payload fields are the bulk of a large listing and belong to `runs/:id`.
    // Each row with a customer tenant also gets its display label.
    return offsetPage(await withTenantLabels(rows.map(toRunListRow)), { total, page, size });
  }

  /**
   * `(status, origin)` counts for the runs matching the same tag/tenant/attribute predicates as
   * `GET runs`. This is what lets that listing be PAGED at all: the page bounds what the console
   * renders, this bounds nothing and keeps its status and origin chips exact.
   *
   * `filter[status]`, `filter[origin]` and `filter[unattributed]` are accepted (the route takes the
   * same filter) but deliberately DROPPED before counting — they are the axes being counted, so
   * narrowing by them would report the answer back to itself.
   */
  @Get('runs/facets')
  async facets(@Query() query: Record<string, unknown> = {}) {
    rejectUnknownParams(query, ['filter']);
    const draft = await this.runDraft(query);
    return { data: await this.dashboard.runFacets(draft.facetQuery()) };
  }

  /**
   * The distinct values one filter field takes across the runs matching every OTHER active
   * predicate, with counts — what the console's tenant/tag/attribute pickers list.
   *
   * `?groupByCount[field]=tag&groupByCount[limit]=20` (`@dudousxd/nestjs-filter`'s own facet wire,
   * kept by design), with the filters in the same `filter[...]` form as `GET runs`. Scoping the
   * values to the active filters is the point: picking a tenant leaves the tag picker offering only
   * that tenant's tags, so a picker never offers a value whose result set is empty.
   *
   * `limit` matters rather than being a nicety — tag and attribute cardinality grows with the data
   * (a `singleton:<key>` tag is minted per key), so the unbounded answer is a listing. `offset` and
   * `search` are what make that bound livable: a picker pages as it scrolls and narrows as the
   * operator types, both server-side, so a value outside the first page is still reachable.
   */
  @Get('runs/values')
  async values(@Query() query: Record<string, unknown> = {}) {
    rejectUnknownParams(query, ['filter', 'groupByCount']);
    return this.runner.groupByCount(DurableRun, runFilterInput(query), { filterClass: RunFilter });
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

  /**
   * The persisted schedules (`engine.schedules`), soonest-due first, as `{ data }`: a short list
   * bounded by `size` (default 200, at most 1000), optionally narrowed by `filter[namespace]`,
   * `filter[workflow]`, `filter[tag]` and `filter[paused]=true|false`. Not paged: the store cannot
   * count schedules, and its soonest-due order moves every time one fires, so neither an offset
   * page nor a cursor over it would be stable. Empty on a tenant or a store without schedules.
   */
  @Get('schedules')
  async schedules(@Query() query: Record<string, unknown> = {}) {
    rejectUnknownParams(query, ['filter', 'size']);
    const filters = parseFilterParams(query, {
      fields: { namespace: ['eq'], workflow: ['eq'], tag: ['eq'], paused: ['eq'] },
    });
    const narrow: { namespace?: string; workflow?: string; tag?: string; paused?: boolean } = {};
    for (const { field, value } of filters) {
      const text = String(value);
      if (field === 'paused') {
        if (text !== 'true' && text !== 'false') {
          throw new ListQueryError('Invalid filter: "filter[paused]" must be true or false.');
        }
        narrow.paused = text === 'true';
      } else {
        narrow[field] = text;
      }
    }
    const { size } = parsePageParams(
      { size: query.size },
      { defaultSize: SCHEDULES_SIZE, maxSize: SCHEDULES_MAX },
    );
    return { data: await this.dashboard.listSchedules({ ...narrow, limit: size }) };
  }

  @Post('schedules/:id/pause')
  pauseSchedule(@Param('id') id: string) {
    return this.dashboard.pauseSchedule(id).catch(notFound);
  }

  @Post('schedules/:id/resume')
  resumeSchedule(@Param('id') id: string) {
    return this.dashboard.resumeSchedule(id).catch(notFound);
  }

  /** Start one run of the schedule now, outside its cadence. */
  @Post('schedules/:id/trigger')
  triggerSchedule(@Param('id') id: string) {
    return this.dashboard.triggerSchedule(id).catch(notFound);
  }

  /**
   * Who starts whom through lifecycle events, for one workflow: the workflows that start when it
   * settles, and the ones whose settling starts it. What the console's workflow page lists.
   */
  @Get('workflows/:name/lifecycle')
  async workflowLifecycle(@Param('name') name: string) {
    const links = await this.dashboard.workflowLifecycle(name).catch(notSupportedByServer);
    if (!links)
      throw new NotImplementedException('workflow lifecycle links need the control plane');
    return links;
  }

  /** This deployment's durable role (control plane vs tenant) + tenant name — for the header badge. */
  @Get('topology')
  topology() {
    return this.dashboard.topology();
  }

  /**
   * A run's detail. Fans wider than {@link FAN_INLINE_MAX} come back as one `FanSummary` each, their
   * members paged by `runs/:id/fans/:group`; `?full=true` returns every checkpoint instead.
   *
   * When the gateway can version the detail without reading it, the response carries an `ETag`, and
   * a poll whose `If-None-Match` still names it gets a 304 before the timeline is read. The browser
   * sends that header itself (the response is `no-cache`), so a console poll needs no code for it.
   */
  @Get('runs/:id')
  async run(
    @Param('id') id: string,
    @Query('full') full?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
    @Res({ passthrough: true }) response?: unknown,
  ) {
    const detail = await this.dashboard.getRunDetail(
      id,
      full === 'true'
        ? undefined
        : { summarizeFansOver: FAN_INLINE_MAX, ...(ifNoneMatch && { ifNoneMatch }) },
    );
    if (!detail) throw new NotFoundException(`run ${id} not found`);
    const { etag, notModified, ...body } = detail;
    if (etag) {
      if (notModified) throw new NotModifiedException(etag);
      setEtag(response, etag);
    }
    const [run = body.run] = await withTenantLabels([body.run]);
    return { ...body, run };
  }

  /**
   * One page of a summarized fan's members, in seq order: `page`/`size` (default 100, at most 500)
   * and `filter[failed]=true` for the failed members only, as an offset page. Versioned like
   * {@link run}.
   */
  @Get('runs/:id/fans/:group')
  async fanMembers(
    @Param('id') id: string,
    @Param('group') group: string,
    @Query() query: Record<string, unknown> = {},
    @Headers('if-none-match') ifNoneMatch?: string,
    @Res({ passthrough: true }) response?: unknown,
  ): Promise<OffsetPage<unknown>> {
    rejectUnknownParams(query, ['page', 'size', 'filter']);
    const { page, size, offset } = parsePageParams(query, {
      defaultSize: FAN_PAGE_SIZE,
      maxSize: FAN_PAGE_MAX,
    });
    let failedOnly = false;
    for (const { value } of parseFilterParams(query, { fields: { failed: ['eq'] } })) {
      if (value !== 'true' && value !== 'false') {
        throw new ListQueryError('Invalid filter: "filter[failed]" must be true or false.');
      }
      failedOnly = value === 'true';
    }
    const result = await this.dashboard.getFanMembers(id, group, {
      offset,
      limit: size,
      failedOnly,
      ...(ifNoneMatch && { ifNoneMatch }),
    });
    if (!result) throw new NotFoundException(`fan ${group} of run ${id} not found`);
    const { etag, notModified, items, total } = result;
    if (etag) {
      if (notModified) throw new NotModifiedException(etag);
      setEtag(response, etag);
    }
    return offsetPage(items, { total, page, size });
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
   * The filter takes the SAME `filter[...]` params as `GET runs` and is parsed identically, so
   * "retry all" acts on exactly the set the operator was looking at rather than a wider one. Page
   * params are not part of it: `bulk` acts on the whole matching SET (it applies its own bound).
   */
  @Post('bulk/:action')
  async bulk(
    @Param('action') action: 'retry' | 'cancel',
    @Query() query: Record<string, unknown> = {},
  ) {
    rejectUnknownParams(query, ['filter', 'compensate']);
    const draft = await this.runDraft(query);
    return this.dashboard.bulk(action === 'cancel' ? 'cancel' : 'retry', draft.query, {
      compensate: query.compensate === 'true',
    });
  }

  @Post('runs/:id/cancel')
  async cancel(@Param('id') id: string, @Query('compensate') compensate?: string) {
    const result = await this.dashboard.cancel(id, { compensate: compensate === 'true' });
    if (!result) throw new NotFoundException(`run ${id} not found`);
    return result;
  }

  /**
   * Publish a settled run's lifecycle event again, to the subscribers that have not started from it
   * (or only `subscriber`). Same gate as retry/cancel.
   */
  @Post('runs/:id/republish-lifecycle')
  async republishLifecycle(@Param('id') id: string, @Body() body?: { subscriber?: string }) {
    let result: Awaited<ReturnType<DashboardService['republishLifecycle']>>;
    try {
      result = await this.dashboard.republishLifecycle(id, body?.subscriber || undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/^run .* not found$/.test(message)) throw new NotFoundException(message);
      if (/^run .* has not settled/.test(message)) throw new BadRequestException(message);
      if ((error as { code?: unknown } | null)?.code === 'bad-request') {
        throw new BadRequestException(message);
      }
      return notSupportedByServer(error);
    }
    if (!result) {
      throw new NotImplementedException('republishing lifecycle events needs the control plane');
    }
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
   * and the body resumes the waiting run. Not a console route: the console's `authorize` does not
   * apply, the token is the secret. The app's `decorators` still do. Treat the token as a secret
   * and/or front it with signature verification in your own middleware.
   */
  @ConsolePublic()
  @Post('webhooks/:token')
  async webhook(@Param('token') token: string, @Body() body: unknown) {
    const result = await this.dashboard.deliverWebhook(token, body);
    if (!result) throw new NotFoundException(`no live run is waiting for webhook ${token}`);
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

  /** The request's `filter[...]` as a {@link RunQueryDraft}, applied through {@link RunFilter}. */
  private async runDraft(query: Record<string, unknown>): Promise<RunQueryDraft> {
    const draft = new RunQueryDraft();
    await this.runner.apply(RunFilter, { filter: { where: runColumnFilters(query) } }, draft);
    return draft;
  }
}

/** Map core's `ScheduleNotFoundError` to a 404; rethrow anything else. */
function notFound(error: unknown): never {
  if (error instanceof Error && error.name === 'ScheduleNotFoundError') {
    throw new NotFoundException(error.message);
  }
  throw error;
}

/**
 * A tenant proxy's control plane that is older than the verb (a `RunGatewayError` with code
 * `unsupported-request`) as 501, every other error as it is.
 */
function notSupportedByServer(error: unknown): never {
  if ((error as { code?: unknown } | null)?.code === 'unsupported-request') {
    throw new NotImplementedException(error instanceof Error ? error.message : String(error));
  }
  throw error;
}

/**
 * The JSON API controller `DurableDashboardModule.forRoot(...)` mounts at `apiBasePath`. The module
 * puts the `@nestjs/authorization` open mark on THIS class (and `decorators` on a per-registration
 * subclass of it), never on {@link DurableApiControllerBase}, so a host's own subclass of the base
 * inherits none of them.
 */
@Controller()
export class DurableApiController extends DurableApiControllerBase {}
