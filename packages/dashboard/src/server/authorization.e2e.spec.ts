import 'reflect-metadata';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import {
  type CanActivate,
  Controller,
  type DynamicModule,
  Global,
  Injectable,
  Module,
  type Type,
  UseGuards,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CAN_ANYONE_METADATA } from './controller-decorators.js';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController, DurableApiControllerBase } from './durable-api.controller.js';
import { DurableAuthController } from './durable-auth.controller.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';
import { DurableUiController, DurableUiControllerBase } from './durable-ui.controller.js';
import { RUN_GATEWAY } from './tokens.js';

/**
 * The console under the REAL `@nestjs/authorization`, whose `AuthorizationModule.forRoot()`
 * registers a global guard that refuses every route declaring no `@Can()`.
 */

interface TestUser {
  role: string;
}

@Policy()
class ConsolePolicy {
  view(user: TestUser | null): boolean {
    return user?.role === 'admin';
  }
}

@Injectable()
class MarkerGuard implements CanActivate {
  static calls = 0;
  canActivate(): boolean {
    MarkerGuard.calls += 1;
    return true;
  }
}

const gateway = {
  async listRuns() {
    return [];
  },
  async runFacets() {
    return [];
  },
  async runValueFacets() {
    return [];
  },
};

@Global()
@Module({ providers: [{ provide: RUN_GATEWAY, useValue: gateway }], exports: [RUN_GATEWAY] })
class HostGatewayModule {}

let app: NestExpressApplication | undefined;

async function boot(
  dashboard: DynamicModule,
  controllers: Type[] = [],
): Promise<NestExpressApplication> {
  @Module({
    imports: [HostGatewayModule, AuthorizationModule.forRoot(), dashboard],
    controllers,
    providers: [ConsolePolicy, MarkerGuard],
  })
  class HostRootModule {}

  app = await NestFactory.create<NestExpressApplication>(HostRootModule, {
    logger: false,
    abortOnError: false,
  });
  // Stands in for an authentication step: the user comes from a header, before any guard runs
  // (the global AuthorizationGuard runs before controller guards, so a guard would be too late).
  app.use(
    (
      req: { headers: Record<string, string>; user?: TestUser },
      _res: unknown,
      next: () => void,
    ) => {
      const role = req.headers['x-role'];
      if (role) req.user = { role };
      next();
    },
  );
  await app.init();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('@nestjs/authorization drift', () => {
  it('Can.Anyone() still writes the key this package inlines', () => {
    class Probe {}
    Can.Anyone()(Probe);
    expect(Reflect.getMetadata(CAN_ANYONE_METADATA, Probe)).toBe(true);
    expect(Reflect.getOwnMetadataKeys(Probe)).toEqual([CAN_ANYONE_METADATA]);
  });
});

describe('the console behind AuthorizationModule.forRoot() (global guard, deny by default)', () => {
  it('marks every dashboard controller open by default', () => {
    for (const controller of [DurableApiController, DurableUiController, DurableAuthController]) {
      expect(Reflect.getMetadata(CAN_ANYONE_METADATA, controller)).toBe(true);
    }
  });

  it('with no `decorators`, the API, UI and auth routes answer as before', async () => {
    const server = (
      await boot(
        DurableDashboardModule.forRoot({
          dashboardAuth: {
            secret: 'test-secret',
            // Mode A: the host's own auth (here the x-role header) vouches for the operator.
            session: (req) =>
              (req as { headers: Record<string, string> }).headers['x-role'] ? { id: 'op' } : null,
            login: () => null,
          },
        }),
      )
    ).getHttpServer();

    // The dashboard's own session decides: no cookie => its 401...
    expect((await request(server).get('/durable/api/runs')).status).toBe(401);
    // ...the auth controller is reachable by a guest (the login page, the session mint)...
    const login = await request(server).get('/durable/login');
    expect(login.status).toBe(200);
    expect(login.text).toContain('<form');
    const minted = await request(server).post('/durable/session').set('x-role', 'viewer');
    expect(minted.status).toBe(204);
    const cookie = minted.headers['set-cookie'] as unknown as string[];
    expect(cookie?.length).toBeGreaterThan(0);
    // ...and with its session the API answers, with no `@Can()` anywhere.
    const api = await request(server).get('/durable/api/runs').set('Cookie', cookie);
    expect(api.status).toBe(200);
    expect(api.body).toEqual([]);
  });

  it('with no options at all, a guest reaches the API and the UI handlers', async () => {
    const server = (await boot(DurableDashboardModule.forRoot())).getHttpServer();

    const api = await request(server).get('/durable/api/runs');
    expect(api.status).toBe(200);
    expect(api.body).toEqual([]);
    // Reaches the handler (which 404s an unknown asset), not the guard's 401.
    const ui = await request(server).get('/durable/assets/nope.js');
    expect(ui.status).toBe(404);
  });

  it('enforces a `Can()` passed through `decorators`: denied users are refused, allowed get through', async () => {
    const server = (
      await boot(DurableDashboardModule.forRoot({ decorators: [Can(ConsolePolicy, 'view')] }))
    ).getHttpServer();

    expect((await request(server).get('/durable/api/runs')).status).toBe(401); // guest
    expect((await request(server).get('/durable/api/runs').set('x-role', 'viewer')).status).toBe(
      403,
    );
    expect((await request(server).get('/durable/assets/x.js').set('x-role', 'viewer')).status).toBe(
      403,
    );

    const allowed = await request(server).get('/durable/api/runs').set('x-role', 'admin');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual([]);
    expect((await request(server).get('/durable/assets/x.js').set('x-role', 'admin')).status).toBe(
      404,
    );
  });

  it('forRootAsync takes the same static `decorators`', async () => {
    const server = (
      await boot(
        DurableDashboardModule.forRootAsync({
          useDashboardAuth: () => undefined,
          decorators: [Can(ConsolePolicy, 'view')],
        }),
      )
    ).getHttpServer();

    expect((await request(server).get('/durable/api/runs').set('x-role', 'viewer')).status).toBe(
      403,
    );
    expect((await request(server).get('/durable/api/runs').set('x-role', 'admin')).status).toBe(
      200,
    );
  });

  it('does not leak decorators from one registration into the next', async () => {
    const first = DurableDashboardModule.forRoot({
      decorators: [Can(ConsolePolicy, 'view'), UseGuards(MarkerGuard)],
    });
    // Nothing stuck to the exported classes.
    for (const controller of [DurableApiController, DurableUiController, DurableAuthController]) {
      expect(Reflect.getMetadata('authorization:can', controller)).toBeUndefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []).not.toContain(MarkerGuard);
    }

    // The first registration mounts its own subclasses, carrying its decorators.
    const firstServer = (await boot(first)).getHttpServer();
    expect(
      (await request(firstServer).get('/durable/api/runs').set('x-role', 'viewer')).status,
    ).toBe(403);
    await app?.close();
    app = undefined;

    // A second registration in the same process, without decorators, is open again.
    const second = (await boot(DurableDashboardModule.forRoot())).getHttpServer();
    expect((await request(second).get('/durable/api/runs').set('x-role', 'viewer')).status).toBe(
      200,
    );
    expect((await request(second).get('/durable/api/runs')).status).toBe(200);
  });

  it('keeps the dashboard guards first, then a `UseGuards()` from `decorators`', () => {
    const dynamic = DurableDashboardModule.forRoot({
      dashboardAuth: { secret: 'test-secret', session: () => null },
      decorators: [UseGuards(MarkerGuard)],
    });
    const [ui] = dynamic.controllers ?? [];
    expect(ui).not.toBe(DurableUiController);
    expect(ui?.name).toBe('DurableUiController');
    const guards = Reflect.getMetadata(GUARDS_METADATA, ui as object) as unknown[];
    expect(guards.at(-1)).toBe(MarkerGuard);
    expect(guards.length).toBeGreaterThan(1); // the dashboardAuth session guard, ahead of it
  });
});

describe('the fail-closed production gate and `decorators`', () => {
  let savedNodeEnv: string | undefined;
  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    if (savedNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it('counts a non-empty `decorators` as the stated protection: no allowUnauthenticated needed', async () => {
    const server = (
      await boot(
        DurableDashboardModule.forRoot({
          decorators: [UseGuards(MarkerGuard), Can(ConsolePolicy, 'view')],
        }),
      )
    ).getHttpServer();

    expect((await request(server).get('/durable/api/runs')).status).toBe(401); // guest
    expect((await request(server).get('/durable/api/runs').set('x-role', 'viewer')).status).toBe(
      403,
    );
    const allowed = await request(server).get('/durable/api/runs').set('x-role', 'admin');
    expect(allowed.status).toBe(200); // not the gate's production 403
    expect(allowed.body).toEqual([]);
  });

  it('still denies an unconfigured console, and an empty `decorators` is not protection', async () => {
    for (const options of [{}, { decorators: [] }]) {
      const server = (await boot(DurableDashboardModule.forRoot(options))).getHttpServer();
      const denied = await request(server).get('/durable/api/runs').set('x-role', 'admin');
      expect(denied.status).toBe(403);
      expect(denied.body.message).toContain('NODE_ENV=production');
      await app?.close();
      app = undefined;
    }
  });
});

// The developer's own controllers, serving the console with the official tools: the dashboard
// mounts nothing (`routes: false`), these extend its pristine bases at the paths it was told about.
@Controller('ops/durable')
@UseGuards(MarkerGuard)
@Can(ConsolePolicy, 'view')
class OpsConsoleUi extends DurableUiControllerBase {}

@Controller('ops/durable/api')
@UseGuards(MarkerGuard)
@Can(ConsolePolicy, 'view')
class OpsConsoleApi extends DurableApiControllerBase {}

// A self-mounted API that forgot its `@Can()`.
@Controller('forgot/api')
class ForgotCanApi extends DurableApiControllerBase {}

const selfMounted = () =>
  DurableDashboardModule.forRoot({
    routes: false,
    basePath: '/ops/durable',
    apiBasePath: '/ops/durable/api',
  });

describe('`routes: false`: the console mounted by the developer', () => {
  let savedNodeEnv: string | undefined;
  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    MarkerGuard.calls = 0;
  });
  afterEach(() => {
    if (savedNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it('mounts no controllers, while the services still resolve', async () => {
    const dynamic = selfMounted();
    expect(dynamic.controllers).toEqual([]);
    const booted = await boot(dynamic);
    const server = booted.getHttpServer();
    expect((await request(server).get('/durable/api/runs')).status).toBe(404);
    expect((await request(server).get('/durable')).status).toBe(404);
    expect((await request(server).get('/durable/login')).status).toBe(404);
    const service = booted.get(DashboardService, { strict: false });
    expect(await service.listRuns({})).toEqual([]);
  });

  it('serves the routes from `@Can()`-protected subclasses: guest 401, denied 403, allowed 200', async () => {
    const server = (await boot(selfMounted(), [OpsConsoleUi, OpsConsoleApi])).getHttpServer();

    expect((await request(server).get('/ops/durable/api/runs')).status).toBe(401);
    expect((await request(server).get('/ops/durable/assets/x.js')).status).toBe(401);
    expect(
      (await request(server).get('/ops/durable/api/runs').set('x-role', 'viewer')).status,
    ).toBe(403);
    expect(
      (await request(server).get('/ops/durable/assets/x.js').set('x-role', 'viewer')).status,
    ).toBe(403);

    // Allowed: the inherited handlers run (with the inherited filter interceptor, DI and the
    // production NODE_ENV, which does not gate a self-mounted console).
    const runs = await request(server).get('/ops/durable/api/runs').set('x-role', 'admin');
    expect(runs.status).toBe(200);
    expect(runs.body).toEqual([]);
    const facets = await request(server).get('/ops/durable/api/runs/facets').set('x-role', 'admin');
    expect(facets.status).toBe(200);
    // The UI handler is reached (an unknown asset 404s in the handler, not in a guard).
    expect(
      (await request(server).get('/ops/durable/assets/x.js').set('x-role', 'admin')).status,
    ).toBe(404);
    // The subclass's own `@UseGuards()` ran.
    expect(MarkerGuard.calls).toBeGreaterThan(0);
  });

  it('a self-mounted route with no `@Can()` falls under the global guard and is denied', async () => {
    const server = (await boot(selfMounted(), [ForgotCanApi])).getHttpServer();
    expect((await request(server).get('/forgot/api/runs').set('x-role', 'admin')).status).toBe(403);
  });

  it('the bases carry no guards and no open mark, whatever was mounted before', () => {
    DurableDashboardModule.forRoot({ guards: [MarkerGuard] });
    for (const base of [DurableUiControllerBase, DurableApiControllerBase]) {
      expect(Reflect.getMetadata(CAN_ANYONE_METADATA, base)).toBeUndefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, base)).toBeUndefined();
    }
    expect(Reflect.getMetadata(GUARDS_METADATA, OpsConsoleApi)).toEqual([MarkerGuard]);
  });

  it('refuses the options that only protect mounted routes', () => {
    for (const stray of [
      { guards: [MarkerGuard] },
      { decorators: [Can(ConsolePolicy, 'view')] },
      { dashboardAuth: { secret: 's', session: () => null } },
      { token: 't' },
      { allowUnauthenticated: true },
    ]) {
      expect(() => DurableDashboardModule.forRoot({ routes: false, ...stray })).toThrow(
        /routes: false.*would protect nothing/,
      );
    }
  });
});
