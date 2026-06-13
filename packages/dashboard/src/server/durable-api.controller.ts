import type { RunStatus } from '@dudousxd/nestjs-durable-core';
import { Controller, Get, NotFoundException, Param, Post, Query, Sse } from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';

/** JSON API consumed by the control-plane SPA. Mounted at `apiBasePath` (set by RouterModule). */
@Controller()
export class DurableApiController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('runs')
  runs(@Query('status') status?: RunStatus, @Query('workflow') workflow?: string) {
    return this.dashboard.listRuns({ status, workflow });
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

  @Post('runs/:id/cancel')
  async cancel(@Param('id') id: string) {
    const result = await this.dashboard.cancel(id);
    if (!result) throw new NotFoundException(`run ${id} not found`);
    return result;
  }

  @Post('runs/:id/continue')
  async continue(@Param('id') id: string) {
    const result = await this.dashboard.continue(id);
    if (!result) throw new NotFoundException(`run ${id} is not paused at a breakpoint`);
    return result;
  }
}
