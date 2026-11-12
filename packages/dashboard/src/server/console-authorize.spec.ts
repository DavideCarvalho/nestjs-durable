import 'reflect-metadata';
import { createHash } from 'node:crypto';
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
  anyAuthorize,
  authorizeByToken,
  normalizeConsoleResult,
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

describe('denials are fresh objects', () => {
  it('normalizeConsoleResult never returns a shared object', () => {
    for (const result of [true, false, { allowed: false, reason: 'unauthenticated' }] as const) {
      const first = normalizeConsoleResult(result);
      expect(normalizeConsoleResult(result)).not.toBe(first);
    }
  });

  it('mutating one decision does not change the next one', async () => {
    const { moduleRef } = await moduleRefWith();
    const decide = await resolveConsoleAuthorize(() => false, moduleRef, silent);
    const first = await decide(ctx);
    Object.assign(first, { allowed: true });
    expect(await decide(ctx)).toEqual({ allowed: false, reason: 'forbidden' });

    const throws = await resolveConsoleAuthorize(
      () => {
        throw new Error('x');
      },
      moduleRef,
      { logger: { warn: () => undefined } as unknown as Logger },
    );
    const denied = await throws(ctx);
    Object.assign(denied, { allowed: true });
    expect(await throws(ctx)).toEqual({ allowed: false, reason: 'forbidden' });
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

  it('{ policy, ability }: a configured getUser answering undefined, null or false is a guest (as @Can() sees it)', async () => {
    let answer: unknown;
    const { moduleRef } = await moduleRefWith(
      [AuthorizationModule.forRoot({ globalGuard: false, getUser: () => answer })],
      [ConsolePolicy],
    );
    const decide = await resolveConsoleAuthorize(
      { policy: ConsolePolicy, ability: 'view' },
      moduleRef,
      silent,
    );
    const admin = contextFor({ user: { role: 'admin' } });
    // `request.user` is an admin, but the configured getUser is the only source, as in `@Can()`.
    for (const guest of [undefined, null, false]) {
      answer = guest;
      expect(await decide(admin)).toEqual({ allowed: false, reason: 'unauthenticated' });
    }
  });

  it('{ policy, ability } without AuthorizationModule fails at resolve time (boot)', async () => {
    const { moduleRef } = await moduleRefWith([], [ConsolePolicy]);
    await expect(
      resolveConsoleAuthorize({ policy: ConsolePolicy, ability: 'view' }, moduleRef, silent),
    ).rejects.toThrow(
      '`authorize: { policy, ability }` needs AuthorizationModule.forRoot() from @nestjs/authorization imported in the app',
    );
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
      caller: 'dev-open',
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

const CALLER = `token:${createHash('sha256').update('s3cret').digest('hex').slice(0, 12)}`;

describe('authorizeByToken', () => {
  const decide = authorizeByToken({ token: 's3cret' }) as (
    c: ExecutionContext,
  ) => ConsoleAuthorizeResult;

  it('allows the matching bearer token, naming the caller by a hash of the token', () => {
    const decision = decide(contextFor({ headers: { authorization: 'Bearer s3cret' } }));
    expect(decision).toEqual({ allowed: true, caller: CALLER });
    expect(JSON.stringify(decision)).not.toContain('s3cret');
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

describe('anyAuthorize', () => {
  async function decideWith(...forms: ConsoleAuthorize[]) {
    const { moduleRef } = await moduleRefWith();
    return resolveConsoleAuthorize(anyAuthorize(...forms), moduleRef, silent);
  }

  it('allows when any form allows: a token OR a DI class', async () => {
    const decide = await decideWith(authorizeByToken({ token: 's3cret' }), ConsoleAccess);
    expect(await decide(contextFor({ headers: { authorization: 'Bearer s3cret' } }))).toEqual({
      allowed: true,
      caller: CALLER,
    });
    expect(await decide(contextFor({ headers: { 'x-ok': '1' } }))).toEqual({ allowed: true });
    expect(await decide(contextFor({ headers: { 'x-ok': '0' } }))).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('keeps the caller of the form that allowed, not of a token that did not match', async () => {
    const decide = await decideWith(authorizeByToken({ token: 's3cret' }), () => ({
      allowed: true,
      caller: 'user:9',
    }));
    expect(await decide(contextFor({ headers: { authorization: 'Bearer nope' } }))).toEqual({
      allowed: true,
      caller: 'user:9',
    });
  });

  it('is unauthenticated when any form said so, keeping the first redirectTo', async () => {
    const decide = await decideWith(
      () => false,
      () => ({ redirectTo: '/login' }),
      () => ({ allowed: false, reason: 'unauthenticated' }) as const,
    );
    expect(await decide(ctx)).toEqual({
      allowed: false,
      reason: 'unauthenticated',
      redirectTo: '/login',
    });
  });

  it('is forbidden when every form forbids, and stops at the first allow', async () => {
    const last = vi.fn(() => true);
    const forbidden = await decideWith(
      () => false,
      () => ({ allowed: false, reason: 'forbidden' }) as const,
    );
    expect(await forbidden(ctx)).toEqual({ allowed: false, reason: 'forbidden' });
    const first = await decideWith(() => true, last);
    expect(await first(ctx)).toEqual({ allowed: true });
    expect(last).not.toHaveBeenCalled();
  });

  it('needs at least one form', () => {
    expect(() => anyAuthorize()).toThrow(/at least one/);
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

  it('unauthenticated without redirectTo: a 401 sign-in page for pages, 401 JSON for the API', async () => {
    const server = await boot(
      DurableDashboardModule.forRoot({
        // Declare the context parameter: a zero-parameter arrow gets no contextual return type
        // from the `authorize` union, so its object literal would widen.
        authorize: (_ctx) => ({ allowed: false, reason: 'unauthenticated' }),
      }),
    );
    const page = await request(server).get('/durable').set('Accept', 'text/html');
    expect(page.status).toBe(401);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toContain('Sign in required');

    for (const [path, accept] of [
      ['/durable', 'application/json'],
      ['/durable/api/runs', 'application/json'],
      ['/durable/api/runs', 'text/html'],
    ] as const) {
      const res = await request(server).get(path).set('Accept', accept);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthenticated' });
    }
  });

  it('a policy form without AuthorizationModule fails the boot with a tailored message', async () => {
    await expect(
      boot(
        DurableDashboardModule.forRoot({ authorize: { policy: ConsolePolicy, ability: 'view' } }),
      ),
    ).rejects.toThrow('needs AuthorizationModule.forRoot() from @nestjs/authorization');
  });

  it('covers the run stream (SSE) and actions, but not the webhook route', async () => {
    const server = await boot(DurableDashboardModule.forRoot({ authorize: () => false }));
    expect((await request(server).get('/durable/api/runs/r1/stream')).status).toBe(403);
    expect((await request(server).post('/durable/api/runs/r1/retry')).status).toBe(403);
    // The token is the webhook's secret, so the console gate lets it through (it then fails here
    // for another reason: this test app has no control plane).
    expect((await request(server).post('/durable/api/webhooks/t1').send({})).status).not.toBe(403);
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

  it('`routes: false` logs the warning once too, and the exported guard answers 403', async () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const server = await boot(DurableDashboardModule.forRoot({ routes: false }), [OpsApi]);
    expect(warn.mock.calls.filter(([m]) => m === CONSOLE_AUTHORIZE_MISSING_WARNING)).toHaveLength(
      1,
    );
    const res = await request(server).get('/ops/durable/api/runs');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });
});

@Controller('ops/durable')
@UseConsoleAuthorize()
class OpsUi extends DurableUiControllerBase {}

@Controller('ops/durable/api')
@UseConsoleAuthorize()
class OpsApi extends DurableApiControllerBase {}

/** Stands in for the app's authentication: sets `request.user` from a header. */
@Injectable()
class HeaderAuthGuard {
  canActivate(c: ExecutionContext): boolean {
    const req = c.switchToHttp().getRequest();
    if (req.headers['x-session']) req.user = { role: req.headers['x-session'] };
    return true;
  }
}

// Listed ABOVE the app's auth guard: class decorators apply bottom-up, so the auth guard runs first.
@Controller('auth/durable/api')
@UseConsoleAuthorize()
@UseGuards(HeaderAuthGuard)
class AuthedApi extends DurableApiControllerBase {}

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

  it('listed above the app auth guard, `authorize` sees the user that guard set', async () => {
    const server = await boot(
      DurableDashboardModule.forRoot({ routes: false, authorize: byRole }),
      [AuthedApi],
    );
    expect(
      (await request(server).get('/auth/durable/api/runs').set('x-session', 'admin')).status,
    ).toBe(200);
    expect(
      (await request(server).get('/auth/durable/api/runs').set('x-session', 'viewer')).status,
    ).toBe(403);
    expect((await request(server).get('/auth/durable/api/runs')).status).toBe(401);
  });
});
