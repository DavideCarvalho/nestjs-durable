import 'reflect-metadata';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import {
  type CanActivate,
  type DynamicModule,
  Global,
  Injectable,
  Module,
  UseGuards,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CAN_ANYONE_METADATA } from './controller-decorators.js';
import { DurableApiController } from './durable-api.controller.js';
import { DurableAuthController } from './durable-auth.controller.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';
import { DurableUiController } from './durable-ui.controller.js';
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
  canActivate(): boolean {
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

async function boot(dashboard: DynamicModule): Promise<NestExpressApplication> {
  @Module({
    imports: [HostGatewayModule, AuthorizationModule.forRoot(), dashboard],
    providers: [ConsolePolicy],
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
    const dynamic = DurableDashboardModule.forRoot({ decorators: [UseGuards(MarkerGuard)] });
    const [ui] = dynamic.controllers ?? [];
    expect(ui).not.toBe(DurableUiController);
    expect(ui?.name).toBe('DurableUiController');
    const guards = Reflect.getMetadata(GUARDS_METADATA, ui as object) as unknown[];
    expect(guards.at(-1)).toBe(MarkerGuard);
    expect(guards.length).toBeGreaterThan(1); // the fail-closed gate, ahead of it
  });
});
