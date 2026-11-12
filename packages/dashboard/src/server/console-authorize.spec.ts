import 'reflect-metadata';
import { AuthorizationModule, Policy } from '@nestjs/authorization';
import {
  Controller,
  type DynamicModule,
  type ExecutionContext,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type Type,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_AUTHORIZE_MISSING_WARNING,
  CONSOLE_GATE,
  type ConsoleAuthorize,
  type ConsoleAuthorizeResult,
  type ConsoleAuthorizer,
  UseConsoleAuthorize,
  authorizeByToken,
  resolveConsoleAuthorize,
} from './console-authorize.js';
import { DurableApiControllerBase } from './durable-api.controller.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';
import { DurableUiControllerBase } from './durable-ui.controller.js';
import { RUN_GATEWAY } from './tokens.js';

interface TestUser {
  role: string;
}

function contextFor(req: {
  headers?: Record<string, string>;
  user?: unknown;
  principal?: unknown;
}): ExecutionContext {
  const request = { headers: {}, ...req };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
    getClass: () => Object,
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

const ctx = contextFor({});

@Injectable()
class AuditLog {
  readonly seen: string[] = [];
}

@Injectable()
class ConsoleAccess implements ConsoleAuthorizer {
  static constructed = 0;
  constructor(@Inject(AuditLog) private readonly audit: AuditLog) {
    ConsoleAccess.constructed += 1;
  }
  authorize(context: ExecutionContext): ConsoleAuthorizeResult {
    this.audit.seen.push('checked');
    return context.switchToHttp().getRequest().headers['x-ok'] === '1';
  }
}

@Policy()
class ConsolePolicy {
  view(user: TestUser | null): boolean {
    return user?.role === 'admin';
  }
}

let contexts: Array<{ close(): Promise<void> }> = [];

async function moduleRefWith(imports: DynamicModule['imports'] = [], providers: Type[] = []) {
  @Global()
  @Module({ providers: [AuditLog], exports: [AuditLog] })
  class AuditModule {}

  @Module({ imports: [AuditModule, ...(imports ?? [])], providers })
  class Root {}

  const app = await NestFactory.createApplicationContext(Root, { logger: false });
  contexts.push(app);
  return { moduleRef: app.get(ModuleRef), audit: app.get(AuditLog) };
}

afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
  vi.restoreAllMocks();
});

const silent = { logger: new Logger('test'), warnIfMissing: false };

describe('resolveConsoleAuthorize: result shapes', () => {
  it.each<[ConsoleAuthorizeResult, unknown]>([
    [true, { allowed: true }],
    [false, { allowed: false, reason: 'forbidden' }],
    [{ allowed: true }, { allowed: true }],
    [{ allowed: false }, { allowed: false, reason: 'forbidden' }],
    [
      { allowed: false, reason: 'forbidden' },
      { allowed: false, reason: 'forbidden' },
    ],
    [
      { allowed: false, reason: 'unauthenticated' },
      { allowed: false, reason: 'unauthenticated' },
    ],
    [{ redirectTo: '/login' }, { allowed: false, reason: 'unauthenticated', redirectTo: '/login' }],
  ])('%j → %j', async (result, decision) => {
    const { moduleRef } = await moduleRefWith();
    const decide = await resolveConsoleAuthorize(() => result, moduleRef, silent);
    expect(await decide(ctx)).toEqual(decision);
    const asyncDecide = await resolveConsoleAuthorize(async () => result, moduleRef, silent);
    expect(await asyncDecide(ctx)).toEqual(decision);
  });
});

describe('resolveConsoleAuthorize: the five forms', () => {
  beforeEach(() => {
    ConsoleAccess.constructed = 0;
  });

  it('inline function: gets the execution context', async () => {
    const { moduleRef } = await moduleRefWith();
    const decide = await resolveConsoleAuthorize(
      (c) => c.switchToHttp().getRequest().user?.isAdmin === true,
      moduleRef,
      silent,
    );
    expect(await decide(contextFor({ user: { isAdmin: true } }))).toEqual({ allowed: true });
    expect(await decide(contextFor({ user: { isAdmin: false } }))).toMatchObject({
      allowed: false,
    });
  });

  it('class: created once through DI, its dependencies injected', async () => {
    const { moduleRef, audit } = await moduleRefWith();
    const decide = await resolveConsoleAuthorize(ConsoleAccess, moduleRef, silent);
    expect(await decide(contextFor({ headers: { 'x-ok': '1' } }))).toEqual({ allowed: true });
    expect(await decide(ctx)).toEqual({ allowed: false, reason: 'forbidden' });
    expect(ConsoleAccess.constructed).toBe(1);
    expect(audit.seen).toEqual(['checked', 'checked']);
  });

  it('class registered as a provider: that instance is used', async () => {
    const { moduleRef } = await moduleRefWith([], [ConsoleAccess]);
    const registered = moduleRef.get(ConsoleAccess, { strict: false });
    const spy = vi.spyOn(registered, 'authorize');
    const decide = await resolveConsoleAuthorize(ConsoleAccess, moduleRef, silent);
    await decide(ctx);
    expect(spy).toHaveBeenCalledOnce();
    expect(ConsoleAccess.constructed).toBe(1);
  });

  it('lazy import: imported once, then the class is reused', async () => {
    const { moduleRef } = await moduleRefWith();
    const load = vi.fn(async () => ({ default: ConsoleAccess }));
    const decide = await resolveConsoleAuthorize(load, moduleRef, silent);
    expect(await decide(contextFor({ headers: { 'x-ok': '1' } }))).toEqual({ allowed: true });
    expect(await decide(ctx)).toEqual({ allowed: false, reason: 'forbidden' });
    expect(load).toHaveBeenCalledOnce();
    expect(ConsoleAccess.constructed).toBe(1);
  });

  it('{ policy, ability }: checked by @nestjs/authorization; guest 401, denied 403', async () => {
    const { moduleRef } = await moduleRefWith(
      [AuthorizationModule.forRoot({ globalGuard: false })],
      [ConsolePolicy],
    );
    const decide = await resolveConsoleAuthorize(
      { policy: ConsolePolicy, ability: 'view' },
      moduleRef,
      silent,
    );
    expect(await decide(contextFor({ user: { role: 'admin' } }))).toEqual({ allowed: true });
    expect(await decide(contextFor({ user: { role: 'viewer' } }))).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
    expect(await decide(contextFor({}))).toEqual({ allowed: false, reason: 'unauthenticated' });
  });

  it('{ policy, ability } uses the module getUser', async () => {
    const { moduleRef } = await moduleRefWith(
      [
        AuthorizationModule.forRoot({
          globalGuard: false,
          getUser: (c: ExecutionContext) => c.switchToHttp().getRequest().principal,
        }),
      ],
      [ConsolePolicy],
    );
    const decide = await resolveConsoleAuthorize(
      { policy: ConsolePolicy, ability: 'view' },
      moduleRef,
      silent,
    );
    // `request.user` says viewer; the configured getUser reads `principal`, an admin.
    const context = contextFor({ user: { role: 'viewer' }, principal: { role: 'admin' } });
    expect(await decide(context)).toEqual({ allowed: true });
  });

  it('{ policy, ability } without AuthorizationModule fails at resolve time (boot)', async () => {
    const { moduleRef } = await moduleRefWith();
    await expect(
      resolveConsoleAuthorize({ policy: ConsolePolicy, ability: 'view' }, moduleRef, silent),
    ).rejects.toThrow(/AuthorizationModule/);
  });

  it('gate name: asks the console-gate provider', async () => {
    const allows = vi.fn(async (name: string) => name === 'console.durable');
    @Global()
    @Module({
      providers: [{ provide: CONSOLE_GATE, useValue: { allows } }],
      exports: [CONSOLE_GATE],
    })
    class FakeAuthz {}
    const { moduleRef } = await moduleRefWith([FakeAuthz]);
    expect(
      await (await resolveConsoleAuthorize('console.durable', moduleRef, silent))(ctx),
    ).toEqual({ allowed: true });
    expect(await (await resolveConsoleAuthorize('other', moduleRef, silent))(ctx)).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
    expect(allows).toHaveBeenCalledWith('console.durable', ctx);
  });

  it('gate name without the console-gate provider fails at resolve time (boot)', async () => {
    const { moduleRef } = await moduleRefWith();
    await expect(resolveConsoleAuthorize('console.durable', moduleRef, silent)).rejects.toThrow(
      "`authorize: 'console.durable'` needs @dudousxd/nestjs-authz's AuthzModule",
    );
  });

  it('a throw is a denial, never an allow, and is logged', async () => {
    const { moduleRef } = await moduleRefWith();
    const logger = new Logger('test');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const decide = await resolveConsoleAuthorize(
      () => {
        throw new Error('boom');
      },
      moduleRef,
      { logger },
    );
    expect(await decide(ctx)).toEqual({ allowed: false, reason: 'forbidden' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('resolveConsoleAuthorize: omitted', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NODE_ENV;
  });
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else process.env.NODE_ENV = saved;
  });

  it('is open outside production and forbidden in production, with the warning', async () => {
    const { moduleRef } = await moduleRefWith();
    const logger = new Logger('test');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    process.env.NODE_ENV = 'development';
    expect(await (await resolveConsoleAuthorize(undefined, moduleRef, { logger }))(ctx)).toEqual({
      allowed: true,
    });
    process.env.NODE_ENV = 'production';
    expect(await (await resolveConsoleAuthorize(undefined, moduleRef, { logger }))(ctx)).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
    expect(warn).toHaveBeenCalledWith(CONSOLE_AUTHORIZE_MISSING_WARNING);
    expect(CONSOLE_AUTHORIZE_MISSING_WARNING).toBe(
      '[@dudousxd/nestjs-durable-dashboard] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in DurableDashboardModule.forRoot().',
    );
  });
});

describe('authorizeByToken', () => {
  const decide = authorizeByToken({ token: 's3cret' }) as (
    c: ExecutionContext,
  ) => ConsoleAuthorizeResult;

  it('allows the matching bearer token', () => {
    expect(decide(contextFor({ headers: { authorization: 'Bearer s3cret' } }))).toBe(true);
  });

  it('a wrong token, another scheme or no header is unauthenticated', () => {
    for (const authorization of ['Bearer nope', 'Basic s3cret', 's3cret', 'Bearer ']) {
      expect(decide(contextFor({ headers: { authorization } }))).toEqual({
        allowed: false,
        reason: 'unauthenticated',
      });
    }
    expect(decide(contextFor({}))).toEqual({ allowed: false, reason: 'unauthenticated' });
  });

  it('throws on an empty or missing token (config time)', () => {
    expect(() => authorizeByToken({ token: '' })).toThrow(/empty/);
    expect(() => authorizeByToken({ token: undefined })).toThrow(/empty/);
  });
});

// ---------------------------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------------------------

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
  async getRun() {
    return undefined;
  },
};

@Global()
@Module({ providers: [{ provide: RUN_GATEWAY, useValue: gateway }], exports: [RUN_GATEWAY] })
class HostGatewayModule {}

let app: NestExpressApplication | undefined;

async function boot(dashboard: DynamicModule, controllers: Type[] = []) {
  @Module({ imports: [HostGatewayModule, dashboard], controllers })
  class HostRootModule {}
  app = await NestFactory.create<NestExpressApplication>(HostRootModule, {
    logger: false,
    abortOnError: false,
  });
  app.use(
    (req: { headers: Record<string, string>; user?: TestUser }, _: unknown, next: () => void) => {
      if (req.headers['x-role']) req.user = { role: req.headers['x-role'] };
      next();
    },
  );
  await app.init();
  return app.getHttpServer();
}

const byRole: ConsoleAuthorize = (c) => {
  const user = c.switchToHttp().getRequest().user as TestUser | undefined;
  if (!user) return { redirectTo: '/login' };
  return user.role === 'admin';
};

describe('the console guard over HTTP', () => {
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('allows, 403s with JSON, and redirects pages / 401s API calls', async () => {
    const server = await boot(DurableDashboardModule.forRoot({ authorize: byRole }));

    const allowed = await request(server).get('/durable/api/runs').set('x-role', 'admin');
    expect(allowed.status).toBe(200);

    const forbidden = await request(server).get('/durable/api/runs').set('x-role', 'viewer');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ error: 'forbidden' });

    const api = await request(server).get('/durable/api/runs');
    expect(api.status).toBe(401);
    expect(api.body).toEqual({ error: 'unauthenticated', redirectTo: '/login' });

    const page = await request(server).get('/durable').set('Accept', 'text/html');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');

    // An asset fetch (no `Accept: text/html`) is not a navigation.
    expect((await request(server).get('/durable/assets/x.js')).status).toBe(401);
  });

  it('a forbidden page navigation gets an HTML access-denied page', async () => {
    const server = await boot(DurableDashboardModule.forRoot({ authorize: () => false }));
    const page = await request(server)
      .get('/durable')
      .set('Accept', 'text/html,application/xhtml+xml');
    expect(page.status).toBe(403);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toContain('Access denied');
  });

  it('unauthenticated without redirectTo is a 401 JSON everywhere', async () => {
    const server = await boot(
      DurableDashboardModule.forRoot({
        // Declare the context parameter: a zero-parameter arrow gets no contextual return type
        // from the `authorize` union, so its object literal would widen.
        authorize: (_ctx) => ({ allowed: false, reason: 'unauthenticated' }),
      }),
    );
    for (const [path, accept] of [
      ['/durable', 'text/html'],
      ['/durable/api/runs', 'application/json'],
    ] as const) {
      const res = await request(server).get(path).set('Accept', accept);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthenticated' });
    }
  });

  it('covers the run stream (SSE), actions and the webhook route', async () => {
    const server = await boot(DurableDashboardModule.forRoot({ authorize: () => false }));
    expect((await request(server).get('/durable/api/runs/r1/stream')).status).toBe(403);
    expect((await request(server).post('/durable/api/runs/r1/retry')).status).toBe(403);
    expect((await request(server).post('/durable/api/webhooks/t1').send({})).status).toBe(403);
  });

  it('authorizeByToken: header only, `?token=` ignored', async () => {
    const server = await boot(
      DurableDashboardModule.forRoot({ authorize: authorizeByToken({ token: 'tkn' }) }),
    );
    expect(
      (await request(server).get('/durable/api/runs').set('Authorization', 'Bearer tkn')).status,
    ).toBe(200);
    expect((await request(server).get('/durable/api/runs?token=tkn')).status).toBe(401);
    expect((await request(server).get('/durable/api/runs')).status).toBe(401);
  });

  it('a gate name without nestjs-authz fails the boot', async () => {
    await expect(
      boot(DurableDashboardModule.forRoot({ authorize: 'console.durable' })),
    ).rejects.toThrow(/needs @dudousxd\/nestjs-authz's AuthzModule/);
  });

  it('runs after the guards in `decorators`, so it sees what they set', async () => {
    @Injectable()
    class SetsUser {
      canActivate(c: ExecutionContext): boolean {
        c.switchToHttp().getRequest().user = { role: 'admin' };
        return true;
      }
    }
    const server = await boot(
      DurableDashboardModule.forRoot({
        decorators: [UseGuards(SetsUser)],
        authorize: byRole,
      }),
    );
    expect((await request(server).get('/durable/api/runs')).status).toBe(200);
  });
});

describe('the default over HTTP (`authorize` omitted)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NODE_ENV;
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (saved === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else process.env.NODE_ENV = saved;
  });

  it('outside production: open, one warning', async () => {
    process.env.NODE_ENV = 'development';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const server = await boot(DurableDashboardModule.forRoot());
    expect((await request(server).get('/durable/api/runs')).status).toBe(200);
    expect(warn.mock.calls.filter(([m]) => m === CONSOLE_AUTHORIZE_MISSING_WARNING)).toHaveLength(
      1,
    );
  });

  it('production: boots, 403 on UI, API and SSE, the warning logged exactly once', async () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const server = await boot(DurableDashboardModule.forRoot());
    for (const path of ['/durable', '/durable/api/runs', '/durable/api/runs/r1/stream']) {
      const res = await request(server).get(path);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
    }
    expect(warn.mock.calls.filter(([m]) => m === CONSOLE_AUTHORIZE_MISSING_WARNING)).toHaveLength(
      1,
    );
  });

  it('`routes: false` logs no warning', async () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await boot(DurableDashboardModule.forRoot({ routes: false }));
    expect(warn.mock.calls.filter(([m]) => m === CONSOLE_AUTHORIZE_MISSING_WARNING)).toHaveLength(
      0,
    );
  });
});

@Controller('ops/durable')
@UseConsoleAuthorize()
class OpsUi extends DurableUiControllerBase {}

@Controller('ops/durable/api')
@UseConsoleAuthorize()
class OpsApi extends DurableApiControllerBase {}

describe('`routes: false` with @UseConsoleAuthorize()', () => {
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('applies `authorize` to the self-mounted controllers', async () => {
    const server = await boot(
      DurableDashboardModule.forRoot({
        routes: false,
        basePath: '/ops/durable',
        apiBasePath: '/ops/durable/api',
        authorize: byRole,
      }),
      [OpsUi, OpsApi],
    );
    expect((await request(server).get('/ops/durable/api/runs').set('x-role', 'admin')).status).toBe(
      200,
    );
    expect(
      (await request(server).get('/ops/durable/api/runs').set('x-role', 'viewer')).status,
    ).toBe(403);
    const page = await request(server).get('/ops/durable').set('Accept', 'text/html');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
  });
});
