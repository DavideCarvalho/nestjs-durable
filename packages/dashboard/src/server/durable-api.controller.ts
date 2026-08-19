import type { RunStatus } from '@dudousxd/nestjs-durable-core';
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
} from '@nestjs/common';
import { parseAttrFilters } from './attr-filter.js';
import { DashboardService } from './dashboard.service.js';
import { type RunListRow, toRunListRow } from './run-list-row.js';

/**
 * How the console asks for a page. An absent bound means "no bound" — the historical whole-listing
 * behaviour, kept so an existing API consumer is not silently truncated. A non-numeric or negative
 * value is treated as absent rather than coerced to 0, which would return an empty page and read as
 * "there are no runs".
 */
function pageBounds(limit?: string, offset?: string): { limit?: number; offset?: number } {
  const bound = (raw?: string): number | undefined => {
    const n = Number(raw);
    return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const l = bound(limit);
  const o = bound(offset);
  return { ...(l !== undefined ? { limit: l } : {}), ...(o !== undefined ? { offset: o } : {}) };
}

/**
 * One `status` narrows to that status; several (a repeated param) match ANY of them, which is how a
 * caller asks for a SET — the console's in-flight sibling query, for one. Kept as one param rather
 * than a second `statuses` param so `?status=running&status=suspended` reads the obvious way and an
 * existing single-value caller is unaffected.
 */
function statusPredicate(status?: RunStatus | RunStatus[]): {
  status?: RunStatus;
  statuses?: RunStatus[];
} {
  if (Array.isArray(status)) return status.length ? { statuses: status } : {};
  return status ? { status } : {};
}

/**
 * The origin predicate, which has THREE states rather than two: a named package, the unattributed
 * bucket, or no restriction. `unattributed=true` is its own param instead of a reserved `origin`
 * value because any reserved string is a package name someone can legitimately have, and a console
 * that quietly reinterpreted it would show the wrong runs. An explicit `unattributed` wins over a
 * concurrent `origin`, which is a contradictory request either way.
 */
function originPredicate(origin?: string, unattributed?: string): { origin?: string | null } {
  if (unattributed === 'true' || unattributed === '1') return { origin: null };
  return origin ? { origin } : {};
}

/** JSON API consumed by the control-plane SPA. Mounted at `apiBasePath` (set by RouterModule). */
@Controller()
export class DurableApiController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * The run list, filtered by whatever the operator asked for. Every predicate is OPTIONAL and an
   * omitted one means "don't narrow on this axis" — in particular `namespace`, whose absence keeps
   * the historical, deliberate behaviour that read paths are NOT namespace-scoped (core,
   * `WorkflowRun.namespace`): the console shows every tenant's runs until an operator chooses one.
   * A blank param (`?namespace=`, from a cleared filter box) is the same as an absent one; passing
   * `''` through would be an exact match on a tenant nobody has, i.e. a silently empty console.
   */
  @Get('runs')
  async runs(
    @Query('status') status?: RunStatus | RunStatus[],
    @Query('workflow') workflow?: string,
    @Query('tag') tag?: string,
    @Query('attr') attr?: string | string[],
    @Query('namespace') namespace?: string,
    @Query('origin') origin?: string,
    @Query('unattributed') unattributed?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<RunListRow[]> {
    const runs = await this.dashboard.listRuns({
      ...statusPredicate(status),
      workflow,
      tag,
      attributes: parseAttrFilters(attr),
      namespace: namespace || undefined,
      ...originPredicate(origin, unattributed),
      ...pageBounds(limit, offset),
    });
    // Rows only — the three payload fields are the bulk of a large listing and belong to `runs/:id`.
    return runs.map(toRunListRow);
  }

  /**
   * `(status, origin)` counts for the runs matching the same tag/tenant/attribute predicates as
   * `GET runs`. This is what lets that listing be PAGED at all: the page bounds what the console
   * renders, this bounds nothing and keeps its status and origin chips exact.
   *
   * `status`, `origin` and the page bounds are deliberately NOT accepted — they are the axes being
   * counted, so narrowing by them would report the answer back to itself.
   */
  @Get('runs/facets')
  facets(
    @Query('workflow') workflow?: string,
    @Query('tag') tag?: string,
    @Query('attr') attr?: string | string[],
    @Query('namespace') namespace?: string,
  ) {
    return this.dashboard.runFacets({
      workflow,
      tag,
      attributes: parseAttrFilters(attr),
      namespace: namespace || undefined,
    });
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
    @Query('status') status?: RunStatus,
    @Query('tag') tag?: string,
    @Query('workflow') workflow?: string,
    @Query('attr') attr?: string | string[],
    @Query('compensate') compensate?: string,
    @Query('namespace') namespace?: string,
    @Query('origin') origin?: string,
    @Query('unattributed') unattributed?: string,
  ) {
    return this.dashboard.bulk(
      action === 'cancel' ? 'cancel' : 'retry',
      {
        status,
        tag,
        workflow,
        attributes: parseAttrFilters(attr),
        namespace: namespace || undefined,
        // The unattributed bucket is a scope a console can actually SELECT, so a bulk action launched
        // under it must be narrowed to it. Dropping the param would widen a retry/cancel to every
        // origin — acting on runs the operator was not looking at.
        ...originPredicate(origin, unattributed),
      },
      { compensate: compensate === 'true' },
    );
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
