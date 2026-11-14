import 'reflect-metadata';
import { ApplyFilterInterceptor, FilterRunner } from '@dudousxd/nestjs-filter';
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { ModuleRef, RouterModule } from '@nestjs/core';
import {
  CONSOLE_AUTHORIZE_DECIDE,
  type ConsoleAuthorize,
  UseConsoleAuthorize,
  resolveConsoleAuthorize,
} from './console-authorize.js';
import type { ConsoleSignOutOption, ConsoleViewerResolver } from './console-shell.js';
import { DurableConsoleRegistration, DurableConsolesController } from './console-switcher.js';
import { controllerFor, markOpenToAuthorization } from './controller-decorators.js';
import { DashboardService } from './dashboard.service.js';
import { DurableDevToolsRegistration } from './dev-tools.js';
import { DurableApiController } from './durable-api.controller.js';
import {
  DASHBOARD_API_PATH,
  DASHBOARD_BASE_PATH,
  DurableUiController,
} from './durable-ui.controller.js';
import { RUN_QUERY_ADAPTER, RunQueryAdapter } from './run-query.adapter.js';
import { RunFilter } from './run.filter.js';
import { DASHBOARD_DEV_TOOLS, DASHBOARD_SHELL } from './tokens.js';

// Every controller this module mounts is open to `@nestjs/authorization`'s global guard, which
// denies by default: access is decided by `authorize` (the console's own guard), and a `@Can()`
// passed in `decorators` is still enforced. The `*Base` classes a host extends for `routes: false`
// are NOT marked, so the official guard's deny-by-default applies to a self-mounted console until it
// declares a `@Can()` (or `@Can.Anyone()`).
markOpenToAuthorization(DurableApiController);
markOpenToAuthorization(DurableUiController);
markOpenToAuthorization(DurableConsolesController);

export interface DurableDashboardOptions {
  /**
   * Who may use the console (the SPA, its JSON API and the run stream). Not the `ctx.webhook()`
   * callback (`POST <apiBasePath>/webhooks/:token`), which third parties call with the token as the
   * secret; {@link decorators} still apply to it. One of:
   *
   * - a function `(context) => boolean | { allowed } | { redirectTo }` (may be async);
   * - an `@Injectable()` class implementing {@link ConsoleAuthorizer} (constructor injection works;
   *   its dependencies resolve from {@link imports} or global modules);
   * - a lazy import `() => import('./console-access.js')` whose default export is such a class;
   * - `{ policy, ability }`, checked with `@nestjs/authorization`'s `AuthorizationService`;
   * - a gate name, resolved by `@dudousxd/nestjs-authz`'s `AuthzModule`.
   *
   * `authorizeByToken({ token })` builds one for a bearer token. It runs after the guards in
   * {@link decorators}, so `request.user` is already set.
   *
   * Omitted: the console is open outside production and answers `403` to every request when
   * `NODE_ENV=production`, and one warning is logged at boot.
   */
  authorize?: ConsoleAuthorize;
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
   * `decorators` is not access control on its own: {@link authorize} decides who gets in, and runs
   * after these. Use `decorators` for what must run first, typically authentication.
   *
   * The controllers are marked `Can.Anyone()` for `@nestjs/authorization`, whose global guard
   * otherwise refuses every route that declares no `@Can()`. A `@Can()` passed here is still
   * enforced.
   */
  decorators?: ClassDecorator[];
  /**
   * `false` mounts NO controllers: the SPA and its JSON API are not registered,
   * while every provider still is (the run read/action service, the run filter, the SPA's base
   * paths). Serve the console from controllers of your own instead, by extending
   * {@link DurableUiControllerBase} and {@link DurableApiControllerBase}. Apply `authorize` to them
   * with `@UseConsoleAuthorize()` (listed above your authentication guards, so it runs after them),
   * or protect them with ordinary Nest decorators:
   *
   * ```ts
   * @Controller('ops/durable') @UseConsoleAuthorize() @UseGuards(AuthenticationGuard)
   * class ConsoleUi extends DurableUiControllerBase {}
   * @Controller('ops/durable/api') @UseConsoleAuthorize() @UseGuards(AuthenticationGuard)
   * class ConsoleApi extends DurableApiControllerBase {}
   * // in the module that declares them:
   * imports: [DurableDashboardModule.forRoot({ routes: false, basePath: '/ops/durable', apiBasePath: '/ops/durable/api' })]
   * ```
   *
   * `basePath`/`apiBasePath` still matter here: they are where you mounted the two controllers, and
   * the SPA is told to load its assets from `basePath` and fetch from `apiBasePath`.
   *
   * `authorize` omitted works as for mounted routes: `@UseConsoleAuthorize()` lets every request
   * through outside production and answers `403` in production, and the boot warning is logged.
   * The `*Base` classes carry no
   * guards and no `Can.Anyone()` mark, so under `@nestjs/authorization`'s global guard a subclass
   * without a `@Can()` is denied. `decorators` throws when combined with `routes: false` rather than
   * being silently ignored.
   *
   * Default `true`. Named `routes` rather than `path: false` because `basePath`/`apiBasePath` are
   * strings that keep their meaning (where the console lives) whether or not this module mounts it.
   */
  routes?: boolean;
  /**
   * Register the console's reads and run/schedule actions as developer tools on the agent MCP
   * server's dev endpoint (`/mcp/aviary`), gated by this console's `authorize`. Default: on when
   * the console's routes are mounted, off with `routes: false`.
   */
  devTools?: boolean;
  /**
   * Who the console's sidebar footer says is signed in: `(request) => ({ label, email?, role? })`,
   * sync or async. `null`/`undefined` or a throw shows no user row.
   *
   * Omitted: `request.user` is read structurally — whatever your guards (`decorators`) already put
   * there: `fullName` → `name` → `email` for the label, and `role` or the first of `roles` (a
   * string or `{ name }`). Reading it never triggers an authentication.
   */
  viewer?: ConsoleViewerResolver;
  /**
   * The sidebar footer's sign-out. One of:
   *
   * - `'/logout'`: a POST form to that path (with `_csrf` when the request exposes
   *   `req.csrfToken()`);
   * - `{ href: '/logout' }`: a plain link;
   * - `{ action: '/logout', csrfToken: (request) => token }`: a POST form with your token as `_csrf`;
   * - `false`: none, even when an account console announced one.
   *
   * Omitted: the sign-out an account console announced on the Aviary consoles registry
   * (`account.signOut`), else none. Only same-origin paths (`/x`) are ever sent to the page.
   */
  signOut?: ConsoleSignOutOption;
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

/** The app's `decorators` first, then the console guard, so `authorize` sees `request.user`. */
function consoleController<T extends Type>(base: T, decorators: ClassDecorator[] | undefined): T {
  return controllerFor(base, [...(decorators ?? []), UseConsoleAuthorize()]);
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
    /** See {@link DurableDashboardOptions.authorize}. */
    authorize?: ConsoleAuthorize;
    /** See {@link DurableDashboardOptions.devTools}. Default: on when the routes are mounted. */
    devTools?: boolean;
  }): DynamicModule {
    const routes = options.routes !== false;
    return {
      module: DurableApiModule,
      imports: [...(options.imports ?? [])],
      controllers: routes
        ? [
            consoleController(DurableApiController, options.decorators),
            consoleController(DurableConsolesController, options.decorators),
          ]
        : [],
      providers: [
        DashboardService,
        { provide: DASHBOARD_DEV_TOOLS, useValue: options.devTools ?? routes },
        DurableDevToolsRegistration,
        // Resolved at boot: a gate name without nestjs-authz, or a policy without
        // @nestjs/authorization, fails here rather than on the first request.
        {
          provide: CONSOLE_AUTHORIZE_DECIDE,
          // Also with `routes: false`: `@UseConsoleAuthorize()` still applies the production 403.
          useFactory: (moduleRef: ModuleRef) =>
            resolveConsoleAuthorize(options.authorize, moduleRef),
          inject: [ModuleRef],
        },
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
      exports: routes
        ? [DashboardService, CONSOLE_AUTHORIZE_DECIDE]
        : [DashboardService, FilterRunner, CONSOLE_AUTHORIZE_DECIDE],
    };
  }
}

/**
 * Mounts the control plane: the bundled React SPA at `basePath` and its JSON API at `apiBasePath`
 * (default `<basePath>/api`). Import via `DurableDashboardModule.forRoot(...)` alongside
 * `DurableModule` (global), so it resolves the engine and store.
 *
 * Access is decided by {@link DurableDashboardOptions.authorize}. Without it the console is open
 * outside production and denies every request in production, with one warning at boot.
 * `routes: false` mounts nothing and leaves serving the console to the host's own controllers (see
 * {@link DurableDashboardOptions.routes}).
 */
@Module({})
export class DurableDashboardModule {
  static forRoot(options: DurableDashboardOptions = {}): DynamicModule {
    const basePath = normalize(options.basePath ?? '/durable');
    const apiBasePath = normalize(options.apiBasePath ?? `${basePath}/api`);
    const pathProviders: Provider[] = [
      { provide: DASHBOARD_BASE_PATH, useValue: basePath },
      { provide: DASHBOARD_API_PATH, useValue: apiBasePath },
      {
        provide: DASHBOARD_SHELL,
        useValue: {
          ...(options.viewer ? { viewer: options.viewer } : {}),
          ...(options.signOut !== undefined ? { signOut: options.signOut } : {}),
        },
      },
    ];
    if (options.routes === false) {
      assertNothingToDecorate(options);
      const api = DurableApiModule.register({
        ...(options.imports ? { imports: options.imports } : {}),
        ...(options.authorize !== undefined ? { authorize: options.authorize } : {}),
        ...(options.devTools !== undefined ? { devTools: options.devTools } : {}),
        routes: false,
      });
      return {
        module: DurableDashboardModule,
        imports: [...(options.imports ?? []), api],
        controllers: [],
        providers: pathProviders,
        // What a host's subclasses of `DurableUiControllerBase` / `DurableApiControllerBase` inject:
        // the SPA's paths, the read/action service, the filter runner and the resolved `authorize`
        // (for `@UseConsoleAuthorize()`) via the API module.
        exports: [DurableApiModule, DASHBOARD_BASE_PATH, DASHBOARD_API_PATH, DASHBOARD_SHELL],
      };
    }
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
          ...(options.authorize !== undefined ? { authorize: options.authorize } : {}),
          ...(options.devTools !== undefined ? { devTools: options.devTools } : {}),
        }),
        RouterModule.register([
          { path: basePath, module: DurableDashboardModule }, // the UI controller below
          { path: apiBasePath, module: DurableApiModule },
        ]),
      ],
      controllers: [consoleController(DurableUiController, options.decorators)],
      // The console switcher lists this console only where it serves its own page.
      providers: [...pathProviders, DurableConsoleRegistration],
      // Re-export the API module so its DashboardService reaches importers (e.g. flip's own controllers).
      exports: [DurableApiModule],
    };
  }
}
