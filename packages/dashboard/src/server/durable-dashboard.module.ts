import { type DynamicModule, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController } from './durable-api.controller.js';
import { DASHBOARD_BASE_PATH, DurableUiController } from './durable-ui.controller.js';

export interface DurableDashboardOptions {
  /**
   * Where to mount the control plane. The SPA serves at `<basePath>` and its JSON API at
   * `<basePath>/api`. Default `/durable`. Set e.g. `/api/durable` to bring it under your app's
   * `/api` prefix (so its auth/proxy rules cover the dashboard API too).
   */
  basePath?: string;
}

/** Leading slash, no trailing slash — so `<base>/api` and the injected client base stay consistent. */
function normalizeBasePath(basePath: string): string {
  return `/${basePath.replace(/^\/+|\/+$/g, '')}`;
}

/**
 * Mounts the control plane — the bundled React SPA plus its JSON API. Import via
 * `DurableDashboardModule.forRoot()` (default `/durable`) or `.forRoot({ basePath: '/api/durable' })`,
 * alongside `DurableModule` (which is global) so it resolves the engine and store. Front a
 * guard/middleware on the base route to protect it.
 */
@Module({})
export class DurableDashboardModule {
  static forRoot(options: DurableDashboardOptions = {}): DynamicModule {
    const basePath = normalizeBasePath(options.basePath ?? '/durable');
    return {
      module: DurableDashboardModule,
      imports: [RouterModule.register([{ path: basePath, module: DurableDashboardModule }])],
      controllers: [DurableUiController, DurableApiController],
      providers: [DashboardService, { provide: DASHBOARD_BASE_PATH, useValue: basePath }],
      exports: [DashboardService],
    };
  }
}
