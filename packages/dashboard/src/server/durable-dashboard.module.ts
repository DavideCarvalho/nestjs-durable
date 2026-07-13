import 'reflect-metadata';
import { type CanActivate, type DynamicModule, Module, type Type } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController } from './durable-api.controller.js';
import {
  DASHBOARD_API_PATH,
  DASHBOARD_BASE_PATH,
  DurableUiController,
} from './durable-ui.controller.js';

/**
 * `@nestjs/common`'s own `GUARDS_METADATA` key, INLINED rather than deep-imported from
 * '@nestjs/common/constants' — that subpath has no extension and a strict ESM resolver (which the
 * built dual ESM/CJS output of this package is loaded under) 404s on it. A drift spec imports the
 * real constant (via the resolvable `'@nestjs/common/constants.js'` subpath) and asserts this literal
 * stays byte-identical to it. Mirrors `@dudousxd/nestjs-agent-dashboard`'s `agent-dashboard.module.ts`.
 */
const GUARDS_METADATA = '__guards__';

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
  /**
   * Guard classes fronting BOTH dashboard controllers (the SPA at `basePath` and its JSON API at
   * `apiBasePath`). Stamped onto each controller via `@nestjs/common`'s own `@UseGuards` metadata key
   * — REPLACE semantics, so a second `forRoot(...)` call overwrites (not appends to) whatever a prior
   * call stamped, same as re-applying `@UseGuards` by hand. Omit to leave the routes unguarded (the
   * host fronts them another way, e.g. a global guard or reverse-proxy auth).
   *
   * A guard's own DEPENDENCIES resolve from this module's `imports` (see {@link imports}) — the
   * dashboard module has no application context of its own to pull them from otherwise.
   *
   * Auth reality for the two mount points: `apiBasePath` is fetched by the SPA's own JS (an XHR/fetch
   * from the same origin), so a guard reading a bearer/`Authorization` header there works exactly like
   * any other API route. `basePath` (the UI shell, `DurableUiController.index()`) is a full-page
   * navigation — the BROWSER issues that GET directly (typing the URL, a bookmark, a link click), so
   * there is no custom header to read: only whatever ambient credential the browser sends by default
   * (a cookie, or nothing) reaches the guard there. A guard that only checks an `Authorization` header
   * will 403 the page shell while the API calls it makes right after would have passed — put session
   * auth behind a cookie (or front the UI mount with your reverse proxy / SSO instead) if you need the
   * shell itself gated.
   */
  guards?: Type<CanActivate>[];
  /**
   * Extra `imports` merged into the dashboard's dynamic module — the DI resolution path for a class
   * passed to {@link guards} (or any other provider the controllers need reachable). Typically the
   * host's own auth module, e.g. `imports: [AuthModule]` alongside `guards: [JwtAuthGuard]`.
   */
  imports?: DynamicModule['imports'];
}

/** Leading slash, no trailing slash. */
function normalize(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

/** Stamp (or clear) `@UseGuards`-equivalent metadata on the dashboard controllers — REPLACE, not append. */
function stampGuards(guards: Type<CanActivate>[] | undefined, ...controllers: Type[]): void {
  for (const controller of controllers) {
    Reflect.defineMetadata(GUARDS_METADATA, guards ?? [], controller);
  }
}

/**
 * Holds the JSON API controller + its read service, mounted on its own path by `forRoot`. Dynamic:
 * guards are DI-instantiated by the CONTROLLER's host module, so this module — not the outer wrapper
 * — must carry the guard classes as providers plus the host's `imports` that resolve their
 * dependencies. A static module here made `guards: [SomeGuardWithDeps]` fail at boot with "Nest can't
 * resolve dependencies ... in the DurableApiModule context" even when the host passed the right
 * `imports` to `forRoot` (mirrors `@dudousxd/nestjs-agent-dashboard`'s `AgentApiModule`).
 */
@Module({})
export class DurableApiModule {
  static register(options: {
    imports?: DynamicModule['imports'];
    guards?: Type<CanActivate>[];
  }): DynamicModule {
    return {
      module: DurableApiModule,
      imports: [...(options.imports ?? [])],
      controllers: [DurableApiController],
      providers: [DashboardService, ...(options.guards ?? [])],
      exports: [DashboardService],
    };
  }
}

/**
 * Mounts the control plane: the bundled React SPA at `basePath` and its JSON API at `apiBasePath`
 * (default `<basePath>/api`). Import via `DurableDashboardModule.forRoot(...)` alongside
 * `DurableModule` (global), so it resolves the engine and store. Front the routes with the first-class
 * `guards` option (plus `imports` for the guards' own dependencies) — see
 * {@link DurableDashboardOptions.guards}.
 */
@Module({})
export class DurableDashboardModule {
  static forRoot(options: DurableDashboardOptions = {}): DynamicModule {
    const basePath = normalize(options.basePath ?? '/durable');
    const apiBasePath = normalize(options.apiBasePath ?? `${basePath}/api`);
    stampGuards(options.guards, DurableApiController, DurableUiController);
    return {
      module: DurableDashboardModule,
      imports: [
        ...(options.imports ?? []),
        // Guards + host imports must reach the API controller's HOST module — enhancers resolve
        // from their controller's own module, never from a parent (see DurableApiModule.register).
        // Spread-only-when-set: exactOptionalPropertyTypes rejects an explicit `undefined`.
        DurableApiModule.register({
          ...(options.imports ? { imports: options.imports } : {}),
          ...(options.guards ? { guards: options.guards } : {}),
        }),
        RouterModule.register([
          { path: basePath, module: DurableDashboardModule }, // the UI controller below
          { path: apiBasePath, module: DurableApiModule },
        ]),
      ],
      controllers: [DurableUiController],
      providers: [
        { provide: DASHBOARD_BASE_PATH, useValue: basePath },
        { provide: DASHBOARD_API_PATH, useValue: apiBasePath },
        // DurableUiController is hosted HERE, so its guards DI-instantiate from this module.
        ...(options.guards ?? []),
      ],
      // Re-export the API module so its DashboardService reaches importers (e.g. flip's own controllers).
      exports: [DurableApiModule],
    };
  }
}
