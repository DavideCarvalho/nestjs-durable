import 'reflect-metadata';
import type { RunGateway, RunListItem } from '@dudousxd/nestjs-durable-core';
import {
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  Global,
  Injectable,
  Logger,
  Module,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signSessionCookie } from './auth/session-cookie.js';
import { DurableApiController } from './durable-api.controller.js';
import {
  DASHBOARD_GATE,
  type DashboardGate,
  DurableDashboardGateGuard,
  readDashboardToken,
  resolveDashboardGate,
} from './durable-dashboard-gate.guard.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';
import { DurableUiController } from './durable-ui.controller.js';
import { RUN_GATEWAY } from './tokens.js';

const gateway = {
  async listRuns(): Promise<RunListItem[]> {
    return [];
  },
  async runFacets() {
    return [];
  },
} as unknown as RunGateway;

@Global()
@Module({ providers: [{ provide: RUN_GATEWAY, useValue: gateway }], exports: [RUN_GATEWAY] })
class HostGatewayModule {}

@Injectable()
class AllowGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

const SECRET = 'gate-spec-secret-key-0123456789abcdef';
const TOKEN = 'gate-spec-token-0123456789';

/** The UI shell answers 404 when the SPA isn't built (unit runs) — anything but 401/403 is "let through". */
const DENIED = [401, 403];

let app: NestExpressApplication | undefined;
let savedNodeEnv: string | undefined;
let savedToken: string | undefined;

async function boot(dashboard: DynamicModule): Promise<NestExpressApplication> {
  @Module({ imports: [HostGatewayModule, dashboard] })
  class HostRootModule {}
  app = await NestFactory.create<NestExpressApplication>(HostRootModule, {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  return app;
}

/**
 * The gate's own boot lines. Nest's framework logs go through the same `Logger.prototype` (e.g.
 * its "Content-Type doesn't match Reply body" warning on the unbuilt-SPA 404), so filter by text.
 */
function dashboardMessages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => /durable console|allowUnauthenticated/.test(message));
}

function server() {
  if (!app) throw new Error('boot() first');
  return app.getHttpServer();
}

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
  savedToken = process.env.DURABLE_DASHBOARD_TOKEN;
  Reflect.deleteProperty(process.env, 'DURABLE_DASHBOARD_TOKEN');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (savedNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedToken === undefined) Reflect.deleteProperty(process.env, 'DURABLE_DASHBOARD_TOKEN');
  else process.env.DURABLE_DASHBOARD_TOKEN = savedToken;
  vi.restoreAllMocks();
});

describe('unconfigured console in production', () => {
  it('denies the UI and the API, and logs one boot error naming every way to configure it', async () => {
    process.env.NODE_ENV = 'Production'; // case-insensitive
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await boot(DurableDashboardModule.forRoot());

    const ui = await request(server()).get('/durable');
    expect(ui.status).toBe(403);
    expect(ui.body.message).toMatch(/not configured/);

    const asset = await request(server()).get('/durable/assets/index.js');
    expect(asset.status).toBe(403);

    const api = await request(server()).get('/durable/api/runs');
    expect(api.status).toBe(403);

    const mutation = await request(server()).post('/durable/api/runs/r1/retry');
    expect(mutation.status).toBe(403);

    const errors = dashboardMessages(error);
    expect(errors).toHaveLength(1);
    const message = errors[0] ?? '';
    for (const hint of [
      'guards',
      'dashboardAuth',
      'DURABLE_DASHBOARD_TOKEN',
      'allowUnauthenticated',
    ]) {
      expect(message).toContain(hint);
    }
  });

  it('forRootAsync whose useDashboardAuth returns undefined is denied too', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await boot(DurableDashboardModule.forRootAsync({ useDashboardAuth: () => undefined }));

    expect((await request(server()).get('/durable')).status).toBe(403);
    expect((await request(server()).get('/durable/api/runs')).status).toBe(403);
  });

  it('keeps the auth routes reachable (only the UI/API controllers are gated)', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await boot(DurableDashboardModule.forRootAsync({ useDashboardAuth: () => undefined }));

    const logout = await request(server()).post('/durable/logout');
    expect(DENIED).not.toContain(logout.status);
  });
});

describe('unconfigured console outside production', () => {
  it('stays open (today’s behaviour) and warns once that production will deny it', async () => {
    process.env.NODE_ENV = 'test';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await boot(DurableDashboardModule.forRoot());

    expect(DENIED).not.toContain((await request(server()).get('/durable')).status);
    expect((await request(server()).get('/durable/api/runs')).status).toBe(200);

    expect(dashboardMessages(error)).toEqual([]);
    const gateWarnings = dashboardMessages(warn);
    expect(gateWarnings).toHaveLength(1);
    expect(gateWarnings[0]).toMatch(/WILL deny every request when NODE_ENV=production/);
  });

  it('treats an unset NODE_ENV as non-production', async () => {
    Reflect.deleteProperty(process.env, 'NODE_ENV');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await boot(DurableDashboardModule.forRoot());

    expect((await request(server()).get('/durable/api/runs')).status).toBe(200);
  });
});

describe('allowUnauthenticated', () => {
  it('serves the console open in production, with a boot warning and no error', async () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await boot(DurableDashboardModule.forRoot({ allowUnauthenticated: true }));

    expect(DENIED).not.toContain((await request(server()).get('/durable')).status);
    expect((await request(server()).get('/durable/api/runs')).status).toBe(200);
    expect(dashboardMessages(error)).toEqual([]);
    const gateWarnings = dashboardMessages(warn);
    expect(gateWarnings).toHaveLength(1);
    expect(gateWarnings[0]).toMatch(/allowUnauthenticated: true/);
  });

  it('works on forRootAsync too', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await boot(
      DurableDashboardModule.forRootAsync({
        allowUnauthenticated: true,
        useDashboardAuth: () => undefined,
      }),
    );

    expect((await request(server()).get('/durable/api/runs')).status).toBe(200);
  });
});

describe('token gate', () => {
  for (const source of ['option', 'env'] as const) {
    describe(`token from ${source}`, () => {
      beforeEach(async () => {
        process.env.NODE_ENV = 'production';
        const error = vi.spyOn(Logger.prototype, 'error');
        if (source === 'env') {
          process.env.DURABLE_DASHBOARD_TOKEN = TOKEN;
          await boot(DurableDashboardModule.forRoot());
        } else {
          await boot(DurableDashboardModule.forRoot({ token: TOKEN }));
        }
        expect(dashboardMessages(error)).toEqual([]);
      });

      it('rejects a request with no token', async () => {
        expect((await request(server()).get('/durable/api/runs')).status).toBe(401);
        expect((await request(server()).get('/durable')).status).toBe(401);
      });

      it('accepts Authorization: Bearer', async () => {
        const res = await request(server())
          .get('/durable/api/runs')
          .set('Authorization', `Bearer ${TOKEN}`);
        expect(res.status).toBe(200);
      });

      it('accepts x-durable-token', async () => {
        const res = await request(server()).get('/durable/api/runs').set('x-durable-token', TOKEN);
        expect(res.status).toBe(200);
      });

      it('accepts ?token= on GET (UI and API)', async () => {
        expect((await request(server()).get(`/durable/api/runs?token=${TOKEN}`)).status).toBe(200);
        expect(DENIED).not.toContain(
          (await request(server()).get(`/durable?token=${TOKEN}`)).status,
        );
      });

      it('accepts ?token= on HEAD', async () => {
        expect((await request(server()).head(`/durable/api/runs?token=${TOKEN}`)).status).toBe(200);
      });

      it('ignores ?token= on a mutating request', async () => {
        const viaQuery = await request(server()).post(`/durable/api/runs/r1/retry?token=${TOKEN}`);
        expect(viaQuery.status).toBe(401);

        const viaHeader = await request(server())
          .post('/durable/api/runs/r1/retry')
          .set('x-durable-token', TOKEN);
        expect(DENIED).not.toContain(viaHeader.status);
      });

      it('rejects a wrong token (same length and different length)', async () => {
        const sameLength = `${TOKEN.slice(0, -1)}X`;
        for (const wrong of [sameLength, 'short', `${TOKEN}-longer`]) {
          const res = await request(server())
            .get('/durable/api/runs')
            .set('Authorization', `Bearer ${wrong}`);
          expect(res.status).toBe(401);
        }
      });
    });
  }

  it('a token beats allowUnauthenticated (a configured secret is never ignored)', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await boot(DurableDashboardModule.forRoot({ token: TOKEN, allowUnauthenticated: true }));

    expect((await request(server()).get('/durable/api/runs')).status).toBe(401);
  });
});

describe('host guards configured', () => {
  it('the gate steps aside in production (not even stamped), and nothing is logged', async () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const error = vi.spyOn(Logger.prototype, 'error');
    await boot(DurableDashboardModule.forRoot({ guards: [AllowGuard] }));

    expect(Reflect.getMetadata(GUARDS_METADATA, DurableUiController)).toEqual([AllowGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, DurableApiController)).toEqual([AllowGuard]);
    expect((await request(server()).get('/durable/api/runs')).status).toBe(200);
    expect(dashboardMessages(warn)).toEqual([]);
    expect(dashboardMessages(error)).toEqual([]);
  });

  it('forRootAsync with guards: gate resolves to delegated', async () => {
    process.env.NODE_ENV = 'production';
    await boot(
      DurableDashboardModule.forRootAsync({
        guards: [AllowGuard],
        useDashboardAuth: () => undefined,
      }),
    );

    expect(app?.get<DashboardGate>(DASHBOARD_GATE)).toEqual({ mode: 'delegated' });
    expect((await request(server()).get('/durable/api/runs')).status).toBe(200);
  });
});

describe('dashboardAuth configured', () => {
  it('forRoot: the session guard is the gate in production', async () => {
    process.env.NODE_ENV = 'production';
    const error = vi.spyOn(Logger.prototype, 'error');
    await boot(
      DurableDashboardModule.forRoot({ dashboardAuth: { secret: SECRET, login: () => null } }),
    );

    // No session: the SESSION guard's 401 (carrying auth modes), not the gate's 403.
    const anonymous = await request(server()).get('/durable/api/runs');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.auth).toEqual({ modes: ['login'] });

    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 60_000 });
    const authed = await request(server())
      .get('/durable/api/runs')
      .set('Cookie', `durable_dashboard_session=${cookie}`);
    expect(authed.status).toBe(200);
    expect(dashboardMessages(error)).toEqual([]);
  });

  it('Flip shape — forRootAsync + useDashboardAuth (session/revalidate), no guards, production', async () => {
    process.env.NODE_ENV = 'production';
    const error = vi.spyOn(Logger.prototype, 'error');
    const warn = vi.spyOn(Logger.prototype, 'warn');

    @Injectable()
    class SessionService {
      resolve() {
        return null;
      }
    }

    @Module({ providers: [SessionService], exports: [SessionService] })
    class HostAuthModule {}

    await boot(
      DurableDashboardModule.forRootAsync({
        basePath: '/admin/durable',
        imports: [HostAuthModule],
        inject: [SessionService],
        useDashboardAuth: (sessions: SessionService) => ({
          secret: SECRET,
          ttl: '8h',
          session: () => sessions.resolve(),
          revalidate: () => true,
        }),
      }),
    );

    expect(app?.get<DashboardGate>(DASHBOARD_GATE)).toEqual({ mode: 'delegated' });
    expect(dashboardMessages(error)).toEqual([]);
    expect(dashboardMessages(warn)).toEqual([]);

    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 60_000 });
    const authed = await request(server())
      .get('/admin/durable/api/runs')
      .set('Cookie', `durable_dashboard_session=${cookie}`);
    expect(authed.status).toBe(200);

    // Anonymous still meets the session guard (401 + modes), never the gate's 403.
    const anonymous = await request(server()).get('/admin/durable/api/runs');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.auth).toEqual({ modes: ['session'] });
  });
});

describe('unit: resolveDashboardGate / readDashboardToken', () => {
  it('ranks guards/dashboardAuth > token > allowUnauthenticated > environment', () => {
    process.env.NODE_ENV = 'production';
    const auth = { secret: SECRET, ttlMs: 1, modes: ['login' as const] };
    expect(resolveDashboardGate({ hasGuards: true, token: TOKEN }, null).mode).toBe('delegated');
    expect(resolveDashboardGate({ hasGuards: false, token: TOKEN }, auth).mode).toBe('delegated');
    expect(
      resolveDashboardGate({ hasGuards: false, token: TOKEN, allowUnauthenticated: true }, null),
    ).toEqual({ mode: 'token', token: TOKEN });
    expect(resolveDashboardGate({ hasGuards: false, allowUnauthenticated: true }, null).mode).toBe(
      'open',
    );
    expect(resolveDashboardGate({ hasGuards: false, token: '' }, null).mode).toBe('deny');
    process.env.NODE_ENV = 'staging';
    expect(resolveDashboardGate({ hasGuards: false }, null).mode).toBe('unconfigured');
  });

  it('reads the query token only on GET/HEAD', () => {
    expect(readDashboardToken({ method: 'GET', headers: {}, query: { token: 'a' } })).toBe('a');
    expect(readDashboardToken({ method: 'head', headers: {}, query: { token: 'a' } })).toBe('a');
    expect(readDashboardToken({ method: 'POST', headers: {}, query: { token: 'a' } })).toBe(
      undefined,
    );
    expect(readDashboardToken({ method: 'POST', headers: { authorization: 'bearer  b ' } })).toBe(
      'b',
    );
    expect(readDashboardToken({ method: 'POST', headers: { 'x-durable-token': 'c' } })).toBe('c');
  });

  it('the guard class is exported for hosts that want to reuse it', () => {
    expect(DurableDashboardGateGuard).toBeTypeOf('function');
  });
});
