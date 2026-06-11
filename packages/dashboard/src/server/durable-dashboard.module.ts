import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController } from './durable-api.controller.js';
import { DurableUiController } from './durable-ui.controller.js';

/**
 * Mounts the control plane at `/durable` — the bundled React SPA plus its JSON API. Import it
 * alongside `DurableModule` (which is global), so it resolves the engine and store. Front a
 * guard/middleware on the `/durable` route to protect it.
 */
@Module({
  controllers: [DurableUiController, DurableApiController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DurableDashboardModule {}
