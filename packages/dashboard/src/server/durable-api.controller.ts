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

/** JSON API consumed by the control-plane SPA. Mounted at `apiBasePath` (set by RouterModule). */
@Controller()
export class DurableApiController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('runs')
  runs(
    @Query('status') status?: RunStatus,
    @Query('workflow') workflow?: string,
    @Query('tag') tag?: string,
    @Query('attr') attr?: string | string[],
  ) {
    return this.dashboard.listRuns({ status, workflow, tag, attributes: parseAttrFilters(attr) });
  }

  /** Prometheus-text metrics (runs/steps by outcome, per-workflow counts) for a scrape. */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics() {
    return this.dashboard.metrics();
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

  /** Bulk retry/cancel every run matching a filter (status / tag / workflow). */
  @Post('bulk/:action')
  bulk(
    @Param('action') action: 'retry' | 'cancel',
    @Query('status') status?: RunStatus,
    @Query('tag') tag?: string,
    @Query('workflow') workflow?: string,
    @Query('attr') attr?: string | string[],
    @Query('compensate') compensate?: string,
  ) {
    return this.dashboard.bulk(
      action === 'cancel' ? 'cancel' : 'retry',
      { status, tag, workflow, attributes: parseAttrFilters(attr) },
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
