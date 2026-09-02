import 'reflect-metadata';
import { ApplyFilterInterceptor, FilterRunner } from '@dudousxd/nestjs-filter';
import {
  type CanActivate,
  type DynamicModule,
  type InjectionToken,
  Module,
  type OptionalFactoryDependency,
  type Provider,
  type Type,
} from '@nestjs/common';
import { ModuleRef, RouterModule } from '@nestjs/core';
import {
  DASHBOARD_AUTH,
  type DashboardAuthOptions,
  resolveDashboardAuth,
} from './auth/dashboard-auth-config.js';
import { DashboardLoginRedirectFilter } from './auth/login-redirect.exception.js';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController } from './durable-api.controller.js';
import { DurableAuthController } from './durable-auth.controller.js';
import { DurableApiSessionGuard, DurableUiSessionGuard } from './durable-session.guard.js';
import {
  DASHBOARD_API_PATH,
  DASHBOARD_BASE_PATH,
  DurableUiController,
} from './durable-ui.controller.js';
import { RUN_QUERY_ADAPTER, RunQueryAdapter } from './run-query.adapter.js';
import { RunFilter } from './run.filter.js';

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
  /**
   * Gate the console (the SPA at `basePath` AND its JSON API at `apiBasePath`) behind a built-in,
   * signed session cookie — no infra required. Two ways to mint it:
   *
   * - **Mode A (`session`, recommended)**: your host app already has its own auth (SSO/OIDC/
   *   whatever) — the host frontend, carrying that auth, POSTs to `<basePath>/session`, your
   *   `session` hook validates the raw request and returns the session user, and this library mints
   *   its cookie from that. No credential this library understands ever exists; you keep your own
   *   identity provider as the source of truth. A page-level request with no valid session (and only
   *   Mode A configured) gets a small server-rendered instruction page telling the visitor to sign in
   *   through your host app, since there is no login page to redirect to.
   * - **Mode B (`login`, standalone fallback)**: no host frontend/IdP to lean on — the durable
   *   dashboard serves its own small, dependency-free, server-rendered login page (`GET
   *   <basePath>/login`, handled by `DurableAuthController`) and your `login` hook validates
   *   submitted username/password. A missing/invalid/expired session redirects a page-level request
   *   to that login page with `?returnTo=<original url>`.
   *
   * Either mode can be used alone, or both together (e.g. Mode A for normal use, Mode B as a
   * break-glass fallback) — at least one is required, or `forRoot`/`forRootAsync` throws at boot
   * (an un-mintable gate is a boot error, not a silently-open or silently-stuck console). An API
   * request (`apiBasePath`, fetched by the SPA's own JS) always gets a plain `401` on a missing
   * session, regardless of mode — the caller reads the status code, not HTML.
   *
   * A third, optional hook — **`revalidate`** — re-checks an already-minted session rather than
   * minting one: once a session cookie is past 50% of its TTL, the guard slides it forward with a
   * fresh one, and if `revalidate` is set it's consulted first, so a deactivated or demoted
   * operator loses access instead of riding a self-renewing cookie indefinitely. It only runs on
   * that renewal path, not on every request, so revocation has **latency, not immediacy**: an
   * operator revoked right after a renewal keeps their existing cookie — and therefore console
   * access — for up to `ttl/2` (4 hours at the default 8h TTL) before the next renewal check catches
   * it. Do not rely on `revalidate` for a same-second cutoff; front the mount with your own guard
   * (see {@link guards}) if you need that.
   *
   * Auth here is mount-level and role-agnostic: this option (and the guards/controller it wires up)
   * has no notion of control-plane vs tenant role (see the durable dashboard's topology note in
   * `dashboard.service.ts`) — nothing role-specific changes based on who logs in.
   *
   * Composes with {@link guards}: when both are set, a request must pass the built-in session check
   * AND every guard in `guards` — the SAME logical-AND semantics `@UseGuards` already gives multiple
   * guards, since the built-in guard is simply prepended to whatever `guards` you pass. Omit to leave
   * the console open (today's behavior, unchanged byte-for-byte) — front it with `guards`, a global
   * guard, or a reverse proxy instead.
   *
   * See {@link DashboardAuthOptions} for the `secret`/`ttl`/`session`/`login`/`revalidate` shape,
   * and `forRootAsync` / {@link DurableDashboardAsyncOptions.useDashboardAuth} when a hook needs DI
   * (e.g. an `EntityManager` to look up an admin user).
   */
  dashboardAuth?: DashboardAuthOptions;
}

/**
 * Async variant of {@link DurableDashboardOptions}. The mount paths and `guards` stay static (the
 * router and guard metadata are bound at module-DEFINITION time — the same constraint `forRoot`
 * already has), but `dashboardAuth` is built by an injected factory, so its `session`/`login` hooks
 * can reach your DB/services — e.g. Mode A's `session` hook calling out to the same auth service
 * your host app already uses to validate the raw request. Returning `undefined` from
 * `useDashboardAuth` leaves the console open, exactly like omitting `dashboardAuth` from `forRoot`.
 */
export interface DurableDashboardAsyncOptions {
  basePath?: string;
  apiBasePath?: string;
  guards?: Type<CanActivate>[];
  imports?: DynamicModule['imports'];
  /** Providers injected into `useDashboardAuth`, in order. Shared with a `guards` class's own deps. */
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  /** Build the `dashboardAuth` config from injected deps (or `undefined` to leave the console open). */
  useDashboardAuth: (
    ...deps: any[]
  ) => DashboardAuthOptions | undefined | Promise<DashboardAuthOptions | undefined>;
}

/** Leading slash, no trailing slash. */
function normalize(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

/**
 * Stamp (or clear) `@UseGuards`-equivalent metadata on a dashboard controller — REPLACE, not
 * append, across repeated calls (a second `forRoot(...)` overwrites whatever a prior call
 * stamped). `builtIn`, when given, is always prepended FIRST — it's the `dashboardAuth` session
 * guard for that controller, which must run before any host `guards` (fail the session check
 * before ever invoking host auth). Passing neither reproduces today's behavior byte-for-byte
 * (an empty array — the controller unguarded).
 */
function stampGuards(
  hostGuards: Type<CanActivate>[] | undefined,
  builtIn: Type<CanActivate> | undefined,
  controller: Type,
): void {
  const merged = [...(builtIn ? [builtIn] : []), ...(hostGuards ?? [])];
  Reflect.defineMetadata(GUARDS_METADATA, merged, controller);
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
    /** Provider for `DASHBOARD_AUTH` — a `useValue` (`forRoot`) or a `useFactory` (`forRootAsync`). */
    authProvider: Provider;
    /** Whether the built-in `DurableApiSessionGuard` should be stamped on `DurableApiController`
     *  (true whenever `dashboardAuth` was set, or unconditionally for `forRootAsync`, where it's
     *  resolved at runtime and is a no-op if it ends up unconfigured). */
    authMayBeConfigured: boolean;
  }): DynamicModule {
    stampGuards(
      options.guards,
      options.authMayBeConfigured ? DurableApiSessionGuard : undefined,
      DurableApiController,
    );
    return {
      module: DurableApiModule,
      imports: [...(options.imports ?? [])],
      controllers: [DurableApiController],
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
        options.authProvider,
        DurableApiSessionGuard,
        ...(options.guards ?? []),
      ],
      exports: [DashboardService],
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
 */
@Module({})
export class DurableDashboardModule {
  static forRoot(options: DurableDashboardOptions = {}): DynamicModule {
    const authProvider: Provider = {
      provide: DASHBOARD_AUTH,
      useValue: resolveDashboardAuth(options.dashboardAuth),
    };
    return DurableDashboardModule.build(options, authProvider, options.dashboardAuth !== undefined);
  }

  static forRootAsync(options: DurableDashboardAsyncOptions): DynamicModule {
    const authProvider: Provider = {
      provide: DASHBOARD_AUTH,
      inject: options.inject ?? [],
      useFactory: async (...deps: any[]) =>
        resolveDashboardAuth(await options.useDashboardAuth(...deps)),
    };
    // Always true: whether the resolved config ends up configured is only known at runtime, so the
    // guards/auth-controller wiring must always be present — `DurableUiSessionGuard`/
    // `DurableApiSessionGuard` are already no-ops when `DASHBOARD_AUTH` resolves to `null`.
    return DurableDashboardModule.build(options, authProvider, true);
  }

  /** Shared wiring: static routing + the API module, with `dashboardAuth` supplied by `authProvider`. */
  private static build(
    options: {
      basePath?: string;
      apiBasePath?: string;
      guards?: Type<CanActivate>[];
      imports?: DynamicModule['imports'];
    },
    authProvider: Provider,
    authMayBeConfigured: boolean,
  ): DynamicModule {
    const basePath = normalize(options.basePath ?? '/durable');
    const apiBasePath = normalize(options.apiBasePath ?? `${basePath}/api`);
    stampGuards(
      options.guards,
      authMayBeConfigured ? DurableUiSessionGuard : undefined,
      DurableUiController,
    );
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
          authProvider,
          authMayBeConfigured,
        }),
        RouterModule.register([
          { path: basePath, module: DurableDashboardModule }, // the UI + auth controllers below
          { path: apiBasePath, module: DurableApiModule },
        ]),
      ],
      controllers: [
        DurableUiController,
        // The auth controller (login page + logout) only exists when dashboardAuth might be
        // configured — mounting it unconditionally would add a new `/login` route even for hosts
        // that never set `dashboardAuth`, breaking "absent -> today's behavior byte-for-byte".
        ...(authMayBeConfigured ? [DurableAuthController] : []),
      ],
      providers: [
        { provide: DASHBOARD_BASE_PATH, useValue: basePath },
        { provide: DASHBOARD_API_PATH, useValue: apiBasePath },
        authProvider,
        DurableUiSessionGuard,
        // DurableUiController (and DurableAuthController, when present) are hosted HERE, so their
        // guards DI-instantiate from this module.
        ...(options.guards ?? []),
      ],
      // Re-export the API module so its DashboardService reaches importers (e.g. flip's own controllers).
      exports: [DurableApiModule],
    };
  }
}
