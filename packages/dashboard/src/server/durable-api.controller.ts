import type { RunStatus } from '@dudousxd/nestjs-durable-core';
import { Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';

/** JSON API consumed by the control-plane SPA. Mounted at `<base>/api` (base from RouterModule). */
@Controller('api')
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
}
