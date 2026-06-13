import { type DynamicModule, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController } from './durable-api.controller.js';
import {
  DASHBOARD_API_PATH,
  DASHBOARD_BASE_PATH,
  DurableUiController,
} from './durable-ui.controller.js';

export interface DurableDashboardOptions {
  /**
   * Where the SPA (UI) is served. Default `/durable`. This is a page route — keep it out of an
   * `/api` prefix so it reads as a UI, not an endpoint.
   */
  basePath?: string;
  /**
   * Where the JSON API is mounted (what the SPA fetches). Default `<basePath>/api`. Set it under
   * your app's `/api` prefix — e.g. `/api/durable` — so the API inherits the app's auth/proxy rules
   * while the UI stays at `basePath`.
   */
  apiBasePath?: string;
}

/** Leading slash, no trailing slash. */
function normalize(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

/** Holds the JSON API controller + its read service, mounted on its own path by `forRoot`. */
@Module({
  controllers: [DurableApiController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DurableApiModule {}

/**
 * Mounts the control plane: the bundled React SPA at `basePath` and its JSON API at `apiBasePath`
 * (default `<basePath>/api`). Import via `DurableDashboardModule.forRoot(...)` alongside
 * `DurableModule` (global), so it resolves the engine and store. Front the routes with a guard.
 */
@Module({})
export class DurableDashboardModule {
  static forRoot(options: DurableDashboardOptions = {}): DynamicModule {
    const basePath = normalize(options.basePath ?? '/durable');
    const apiBasePath = normalize(options.apiBasePath ?? `${basePath}/api`);
    return {
      module: DurableDashboardModule,
      imports: [
        DurableApiModule,
        RouterModule.register([
          { path: basePath, module: DurableDashboardModule }, // the UI controller below
          { path: apiBasePath, module: DurableApiModule },
        ]),
      ],
      controllers: [DurableUiController],
      providers: [
        { provide: DASHBOARD_BASE_PATH, useValue: basePath },
        { provide: DASHBOARD_API_PATH, useValue: apiBasePath },
      ],
      // Re-export the API module so its DashboardService reaches importers (e.g. flip's own controllers).
      exports: [DurableApiModule],
    };
  }
}
