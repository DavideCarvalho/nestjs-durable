import 'reflect-metadata';
import { ApplyFilterInterceptor, FilterRunner } from '@dudousxd/nestjs-filter';
import { type DynamicModule, Logger, Module, type Provider } from '@nestjs/common';
import { ModuleRef, RouterModule } from '@nestjs/core';
import { controllerFor, markOpenToAuthorization } from './controller-decorators.js';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController } from './durable-api.controller.js';
import {
  DASHBOARD_API_PATH,
  DASHBOARD_BASE_PATH,
  DurableUiController,
} from './durable-ui.controller.js';
import { RUN_QUERY_ADAPTER, RunQueryAdapter } from './run-query.adapter.js';
import { RunFilter } from './run.filter.js';

// Every controller this module mounts is open to `@nestjs/authorization`'s global guard, which
// denies by default: an undecorated console is open outside production, and a `@Can()` passed in
// `decorators` is still enforced. The `*Base` classes a host extends for `routes: false` are NOT
// marked, so the official guard's deny-by-default applies to a self-mounted console until it
// declares a `@Can()`.
markOpenToAuthorization(DurableApiController);
markOpenToAuthorization(DurableUiController);

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
   * Extra `imports` merged into the dashboard's dynamic module: the DI resolution path for a guard
   * passed through {@link decorators} (`UseGuards(...)`), whose dependencies resolve from the module
   * that hosts the controller. Typically the host's own auth module, unless it is global.
   */
  imports?: DynamicModule['imports'];
  /**
   * Class decorators applied to BOTH controllers this module mounts (the SPA and its JSON API), the
   * way `@nestjs/mcp`'s own `decorators` option works. Use it to hand the console to the official NestJS tooling, e.g.
   * `[UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]` with `@nestjs/authentication`
   * and `@nestjs/authorization`.
   *
   * Each registration gets fresh subclasses of the controllers, so decorators never leak into
   * another registration or onto the exported classes. A guard named in `UseGuards(...)` resolves
   * its dependencies from {@link imports} (or a global module).
   *
   * A non-empty `decorators` is how a mounted console states its protection. With
   * `NODE_ENV=production`, a mounted console with no (or an empty) `decorators` fails the boot; see
   * {@link DurableDashboardModule}. The module cannot tell a `Can(...)` from a decorator that
   * protects nothing, so passing one is your statement that the console is protected.
   *
   * Default: none. Outside production the console is then served open, and the controllers are
   * marked `Can.Anyone()` for `@nestjs/authorization`, whose global guard otherwise refuses every
   * route that declares no `@Can()`. A `@Can()` passed here is still enforced.
   */
  decorators?: ClassDecorator[];
  /**
   * `false` mounts NO controllers: the SPA and its JSON API are not registered,
   * while every provider still is (the run read/action service, the run filter, the SPA's base
   * paths). Serve the console from controllers of your own instead, protected with ordinary Nest
   * decorators, by extending {@link DurableUiControllerBase} and {@link DurableApiControllerBase}:
   *
   * ```ts
   * @Controller('ops/durable') @UseGuards(AuthenticationGuard) @Can(ConsolePolicy, 'view')
   * class ConsoleUi extends DurableUiControllerBase {}
   * @Controller('ops/durable/api') @UseGuards(AuthenticationGuard) @Can(ConsolePolicy, 'view')
   * class ConsoleApi extends DurableApiControllerBase {}
   * // in the module that declares them:
   * imports: [DurableDashboardModule.forRoot({ routes: false, basePath: '/ops/durable', apiBasePath: '/ops/durable/api' })]
   * ```
   *
   * `basePath`/`apiBasePath` still matter here: they are where you mounted the two controllers, and
   * the SPA is told to load its assets from `basePath` and fetch from `apiBasePath`.
   *
   * The production rule does not apply: this module mounts nothing, and the routes are yours,
   * protected by what you put on them like any other route you write. The `*Base` classes carry no
   * guards and no `Can.Anyone()` mark, so under `@nestjs/authorization`'s global guard a subclass
   * without a `@Can()` is denied. `decorators` throws when combined with `routes: false` rather than
   * being silently ignored.
   *
   * Default `true`. Named `routes` rather than `path: false` because `basePath`/`apiBasePath` are
   * strings that keep their meaning (where the console lives) whether or not this module mounts it.
   */
  routes?: boolean;
}

/** DI token of the boot-time check that refuses an unprotected console in production. */
export const DASHBOARD_PROTECTION_CHECK = Symbol('DASHBOARD_PROTECTION_CHECK');

/** The boot error for a mounted console with no `decorators` under `NODE_ENV=production`. */
export const UNPROTECTED_CONSOLE_IN_PRODUCTION = [
  'DurableDashboardModule: NODE_ENV=production and the durable console is mounted with no',
  'protection, so the app refuses to boot. Protect it one of two ways:',
  "(1) decorators on the mounted console: DurableDashboardModule.forRoot({ decorators: [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')] });",
  "(2) mount it yourself: DurableDashboardModule.forRoot({ routes: false }) plus @Controller('durable') @UseGuards(AuthenticationGuard) @Can(ConsolePolicy, 'view') class ConsoleUi extends DurableUiControllerBase {} (and the same over DurableApiControllerBase at 'durable/api').",
].join(' ');

function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

/**
 * Registered only for a mounted console with no `decorators`. Resolved at boot (not at `forRoot`
 * time), so a `NODE_ENV` set after the module graph is defined still counts: in production it throws
 * {@link UNPROTECTED_CONSOLE_IN_PRODUCTION} and the app does not start; elsewhere it logs one warning
 * and the console is served open.
 */
function protectionCheckProvider(): Provider {
  return {
    provide: DASHBOARD_PROTECTION_CHECK,
    useFactory: (): true => {
      if (isProduction()) throw new Error(UNPROTECTED_CONSOLE_IN_PRODUCTION);
      new Logger('DurableDashboard').warn(
        'The durable console is mounted with no `decorators`, so it is served OPEN (retry/cancel ' +
          'included). That is refused when NODE_ENV=production: pass `decorators` (e.g. ' +
          "[UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]) or mount it yourself " +
          'with `routes: false`.',
      );
      return true;
    },
  };
}

/** `routes: false` mounts nothing, so `decorators` would decorate nothing. Refuse it at boot. */
function assertNothingToDecorate(options: DurableDashboardOptions): void {
  if (options.decorators === undefined) return;
  throw new Error(
    [
      'DurableDashboardModule.forRoot({ routes: false }) mounts no controllers, so `decorators`',
      'would protect nothing. Put your protection on the controllers you mount (extend',
      'DurableUiControllerBase / DurableApiControllerBase and decorate them with @UseGuards /',
      '@Can), and drop `decorators`.',
    ].join(' '),
  );
}

/** Leading slash, no trailing slash. */
function normalize(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

/**
 * Holds the JSON API controller + its read service, mounted on its own path by `forRoot`. Its own
 * dynamic module because enhancers (a guard from `decorators`) DI-instantiate from their
 * controller's host module, so this module, not the outer wrapper, must carry the host's `imports`.
 */
@Module({})
export class DurableApiModule {
  static register(options: {
    imports?: DynamicModule['imports'];
    /** `false`: register the providers only, no controller (see `routes`). */
    routes?: boolean;
    /** See {@link DurableDashboardOptions.decorators}. */
    decorators?: ClassDecorator[];
  }): DynamicModule {
    const routes = options.routes !== false;
    return {
      module: DurableApiModule,
      imports: [...(options.imports ?? [])],
      controllers: routes ? [controllerFor(DurableApiController, options.decorators)] : [],
      providers: [
        DashboardService,
        // `@dudousxd/nestjs-filter` is wired PRIVATELY here rather than through
        // `FilterModule.forRoot()`, which is a global registration. A library calling that would
        // fight the host app over one set of module options and register a second app-wide
        // interceptor — and it cannot tell at module-definition time whether the host already
        // called it. Everything below is scoped to this module, so the console composes with an app
        // that uses the filter library, and with one that has never heard of it, identically.
        //
        // `validation: 'off'`: the run filter's inputs are validated by their own translation —
        // every field/operator pair either maps onto a `RunQuery` predicate or is rejected by
        // name — so there is nothing left for class-validator to check, and requiring it would put
        // a peer dependency on every consumer of this dashboard for no gain.
        //
        // The `null` adapter is the GLOBAL one, deliberately absent: `RunFilter` names its own via
        // `@Filterable({ adapter })`, so the console runs on the durable run gateway while the host
        // app's filters keep running on whatever adapter it registered.
        {
          provide: FilterRunner,
          useFactory: (moduleRef: ModuleRef) =>
            new FilterRunner(moduleRef, { validation: 'off' }, null),
          inject: [ModuleRef],
        },
        ApplyFilterInterceptor,
        RunQueryAdapter,
        { provide: RUN_QUERY_ADAPTER, useExisting: RunQueryAdapter },
        RunFilter,
      ],
      // Self-mounted (`routes: false`): the host's own subclass of `DurableApiControllerBase` is
      // hosted in the HOST's module, so what its constructor injects must be exported. `FilterRunner`
      // is only exported then: exporting it from a mounted console would shadow a host's own
      // `FilterModule` runner in whatever module imports the dashboard.
      exports: routes ? [DashboardService] : [DashboardService, FilterRunner],
    };
  }
}

/**
 * Mounts the control plane: the bundled React SPA at `basePath` and its JSON API at `apiBasePath`
 * (default `<basePath>/api`). Import via `DurableDashboardModule.forRoot(...)` (or `forRootAsync`
 * when `dashboardAuth`'s `login` hook needs injected services) alongside `DurableModule` (global),
 * so it resolves the engine and store. Front the routes with the first-class `guards` option
 * (plus `imports` for the guards' own dependencies) — see {@link DurableDashboardOptions.guards} —
 * or with the built-in `dashboardAuth` cookie login, or both.
 * With none of those (and no `decorators` / `token` / `allowUnauthenticated`), the console fails
 * closed when `NODE_ENV=production` — see {@link DurableDashboardOptions.allowUnauthenticated}.
 * `routes: false` mounts nothing and leaves serving the console to the host's own controllers — see
 * {@link DurableDashboardOptions.routes}.
 */
/**
 * Mounts the control plane: the bundled React SPA at `basePath` and its JSON API at `apiBasePath`
 * (default `<basePath>/api`). Import via `DurableDashboardModule.forRoot(...)` alongside
 * `DurableModule` (global), so it resolves the engine and store.
 *
 * Protect the console with the first-party NestJS tools (`@nestjs/authentication`,
 * `@nestjs/authorization`), one of two ways:
 *
 * 1. `decorators` on the mounted controllers (see {@link DurableDashboardOptions.decorators});
 * 2. `routes: false`, and mount it yourself by extending `DurableUiControllerBase` /
 *    `DurableApiControllerBase` (see {@link DurableDashboardOptions.routes}).
 *
 * With `NODE_ENV=production`, a mounted console with no `decorators` fails the boot with
 * {@link UNPROTECTED_CONSOLE_IN_PRODUCTION}. Outside production it is served open, with a warning.
 */
@Module({})
export class DurableDashboardModule {
  static forRoot(options: DurableDashboardOptions = {}): DynamicModule {
    const basePath = normalize(options.basePath ?? '/durable');
    const apiBasePath = normalize(options.apiBasePath ?? `${basePath}/api`);
    const pathProviders: Provider[] = [
      { provide: DASHBOARD_BASE_PATH, useValue: basePath },
      { provide: DASHBOARD_API_PATH, useValue: apiBasePath },
    ];
    if (options.routes === false) {
      assertNothingToDecorate(options);
      const api = DurableApiModule.register({
        ...(options.imports ? { imports: options.imports } : {}),
        routes: false,
      });
      return {
        module: DurableDashboardModule,
        imports: [...(options.imports ?? []), api],
        controllers: [],
        providers: pathProviders,
        // What a host's subclasses of `DurableUiControllerBase` / `DurableApiControllerBase` inject:
        // the SPA's paths, and the read/action service and the filter runner via the API module.
        exports: [DurableApiModule, DASHBOARD_BASE_PATH, DASHBOARD_API_PATH],
      };
    }
    const decorated = (options.decorators?.length ?? 0) > 0;
    return {
      module: DurableDashboardModule,
      imports: [
        ...(options.imports ?? []),
        // Host imports must reach the API controller's HOST module: enhancers resolve from their
        // controller's own module, never from a parent (see DurableApiModule.register).
        // Spread-only-when-set: exactOptionalPropertyTypes rejects an explicit `undefined`.
        DurableApiModule.register({
          ...(options.imports ? { imports: options.imports } : {}),
          ...(options.decorators ? { decorators: options.decorators } : {}),
        }),
        RouterModule.register([
          { path: basePath, module: DurableDashboardModule }, // the UI controller below
          { path: apiBasePath, module: DurableApiModule },
        ]),
      ],
      controllers: [controllerFor(DurableUiController, options.decorators)],
      providers: [...pathProviders, ...(decorated ? [] : [protectionCheckProvider()])],
      // Re-export the API module so its DashboardService reaches importers (e.g. flip's own controllers).
      exports: [DurableApiModule],
    };
  }
}
