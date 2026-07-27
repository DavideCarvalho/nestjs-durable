import 'reflect-metadata';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA as REAL_GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { DurableApiController } from './durable-api.controller.js';
import { DurableAuthController } from './durable-auth.controller.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';
import { DurableApiSessionGuard, DurableUiSessionGuard } from './durable-session.guard.js';
import { DurableUiController } from './durable-ui.controller.js';

/** The literal `durable-dashboard.module.ts` inlines instead of deep-importing '@nestjs/common/constants'. */
const INLINED_GUARDS_METADATA = '__guards__';

@Injectable()
class FakeGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

describe('GUARDS_METADATA drift', () => {
  it("stays byte-identical to @nestjs/common's real GUARDS_METADATA constant", () => {
    expect(INLINED_GUARDS_METADATA).toBe(REAL_GUARDS_METADATA);
  });
});

describe('DurableDashboardModule.forRoot guards', () => {
  it('stamps the given guards on BOTH controllers (REPLACE semantics)', () => {
    DurableDashboardModule.forRoot({ guards: [FakeGuard] });

    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableApiController)).toEqual([FakeGuard]);
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableUiController)).toEqual([FakeGuard]);
  });

  it('a later forRoot() with no guards clears (not appends to) a prior stamp', () => {
    DurableDashboardModule.forRoot({ guards: [FakeGuard] });
    DurableDashboardModule.forRoot();

    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableApiController)).toEqual([]);
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableUiController)).toEqual([]);
  });

  it('passes an `imports` passthrough into the dynamic module for guard-dependency resolution', () => {
    class FakeAuthModule {}

    const dynamicModule = DurableDashboardModule.forRoot({
      guards: [FakeGuard],
      imports: [FakeAuthModule],
    });

    expect(dynamicModule.imports).toContain(FakeAuthModule);
  });

  it('omitting `imports` still returns a valid dynamic module', () => {
    const dynamicModule = DurableDashboardModule.forRoot();
    expect(dynamicModule.imports?.length).toBeGreaterThan(0);
  });
});

describe('guard DI resolution in the API controller host module', () => {
  // Regression: guards are DI-instantiated by the CONTROLLER's host module. DurableApiController
  // lives in DurableApiModule, which used to be a STATIC module receiving neither the guard
  // providers nor the host's `imports` — a guard WITH dependencies would fail real hosts with
  // "Nest can't resolve dependencies of the <Guard> ... in the DurableApiModule context" even though
  // dependency-less guards (like FakeGuard above) happened to boot fine in isolation.
  it('threads guards + host imports into the API module so a guard with deps resolves', async () => {
    const {
      Inject,
      Module: ModuleDecorator,
      Injectable: InjectableDecorator,
      Global: GlobalDecorator,
    } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { RUN_GATEWAY } = await import('./tokens.js');

    @InjectableDecorator()
    class AuthService {
      allowed(): boolean {
        return false;
      }
    }

    @ModuleDecorator({ providers: [AuthService], exports: [AuthService] })
    class HostAuthModule {}

    @InjectableDecorator()
    class GuardWithDeps implements CanActivate {
      constructor(@Inject(AuthService) private readonly auth: AuthService) {}
      canActivate(_context: ExecutionContext): boolean {
        return this.auth.allowed();
      }
    }

    // Real hosts bind the run-gateway token via a @Global store module (DurableModule); mirror that
    // so DashboardService (inside DurableApiModule) resolves it across the module boundary.
    @GlobalDecorator()
    @ModuleDecorator({
      providers: [{ provide: RUN_GATEWAY, useValue: {} }],
      exports: [RUN_GATEWAY],
    })
    class HostGatewayModule {}

    @ModuleDecorator({
      imports: [
        HostGatewayModule,
        DurableDashboardModule.forRoot({ guards: [GuardWithDeps], imports: [HostAuthModule] }),
      ],
    })
    class HostRootModule {}

    // `createApplicationContext` (not `create`) builds and resolves the FULL DI graph — including
    // every controller's constructor injection — without needing an HTTP adapter (this package has no
    // `@nestjs/platform-express` dependency, unlike a real host app). It still throws "Nest can't
    // resolve dependencies ... in the DurableApiModule context" if the guard providers/imports did not
    // land there (the regressed behavior), which is the only thing this test is proving.
    const app = await NestFactory.createApplicationContext(HostRootModule, {
      logger: false,
      abortOnError: false,
    });
    await app.close();
  });
});

describe('DurableDashboardModule.forRoot dashboardAuth (absent-option)', () => {
  it("stamps NO built-in guard and mounts NO auth controller — byte-for-byte today's behavior", () => {
    const dynamicModule = DurableDashboardModule.forRoot();

    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableApiController)).toEqual([]);
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableUiController)).toEqual([]);
    expect(dynamicModule.controllers).not.toContain(DurableAuthController);
  });
});

describe('DurableDashboardModule.forRoot dashboardAuth (configured)', () => {
  const dashboardAuth = { secret: 'x'.repeat(32), login: () => null };

  it('stamps the built-in session guard on both controllers and mounts the auth controller', () => {
    const dynamicModule = DurableDashboardModule.forRoot({ dashboardAuth });

    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableUiController)).toEqual([
      DurableUiSessionGuard,
    ]);
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableApiController)).toEqual([
      DurableApiSessionGuard,
    ]);
    expect(dynamicModule.controllers).toContain(DurableAuthController);
  });

  it('guards coexistence: composes the built-in guard AND a host guard (built-in runs first)', () => {
    DurableDashboardModule.forRoot({ dashboardAuth, guards: [FakeGuard] });

    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableUiController)).toEqual([
      DurableUiSessionGuard,
      FakeGuard,
    ]);
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableApiController)).toEqual([
      DurableApiSessionGuard,
      FakeGuard,
    ]);
  });

  it('fails closed at forRoot() time when dashboardAuth is misconfigured (missing secret)', () => {
    expect(() =>
      DurableDashboardModule.forRoot({ dashboardAuth: { secret: '', login: () => null } }),
    ).toThrow(/secret is required/);
  });
});

describe('guards coexistence — both actually run (AND semantics)', () => {
  // Regression-shaped: proves the built-in dashboardAuth guard and a host guard are BOTH
  // DI-resolvable off the real host module (not just present in the stamped metadata array), and
  // that invoking them in the stamped order gives the expected AND result — a request must clear
  // the session check AND the host guard, in that order (session first, so a bad session never
  // even reaches the host guard).
  it('both the built-in session guard and a host guard resolve and combine as AND', async () => {
    const {
      Inject,
      Module: ModuleDecorator,
      Injectable: InjectableDecorator,
      Global: GlobalDecorator,
    } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { RUN_GATEWAY } = await import('./tokens.js');
    const { signSessionCookie } = await import('./auth/session-cookie.js');

    const SECRET = 'coexistence-spec-secret-key-0123456789';

    @InjectableDecorator()
    class RoleService {
      isAdmin(): boolean {
        return false; // host guard always denies in this test
      }
    }

    @ModuleDecorator({ providers: [RoleService], exports: [RoleService] })
    class HostAuthModule {}

    @InjectableDecorator()
    class HostGuard implements CanActivate {
      constructor(@Inject(RoleService) private readonly roles: RoleService) {}
      canActivate(_context: ExecutionContext): boolean {
        return this.roles.isAdmin();
      }
    }

    @GlobalDecorator()
    @ModuleDecorator({
      providers: [{ provide: RUN_GATEWAY, useValue: {} }],
      exports: [RUN_GATEWAY],
    })
    class HostGatewayModule {}

    @ModuleDecorator({
      imports: [
        HostGatewayModule,
        DurableDashboardModule.forRoot({
          dashboardAuth: { secret: SECRET, login: () => null },
          guards: [HostGuard],
          imports: [HostAuthModule],
        }),
      ],
    })
    class HostRootModule {}

    const app = await NestFactory.createApplicationContext(HostRootModule, {
      logger: false,
      abortOnError: false,
    });

    const uiSessionGuard = app.get(DurableUiSessionGuard);
    const hostGuard = app.get(HostGuard);

    const validCookie = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: 60_000 });
    const validRequest = { headers: { cookie: `durable_dashboard_session=${validCookie}` } };
    const invalidRequest = { headers: {} };
    const makeContext = (request: unknown): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({ getHeader: () => undefined, setHeader: () => undefined }),
        }),
      }) as unknown as ExecutionContext;

    // Valid session, but the host guard denies => overall AND is false (session guard alone
    // would have said true).
    await expect(uiSessionGuard.canActivate(makeContext(validRequest))).resolves.toBe(true);
    expect(hostGuard.canActivate(makeContext(validRequest))).toBe(false);

    // No session at all => the built-in guard denies FIRST — the host guard is never even
    // reached in the real `@UseGuards` execution order (session guard is stamped first).
    await expect(uiSessionGuard.canActivate(makeContext(invalidRequest))).rejects.toThrow();

    await app.close();
  });

  it('a request passing BOTH the session check and the host guard is allowed', async () => {
    const {
      Module: ModuleDecorator,
      Injectable: InjectableDecorator,
      Global: GlobalDecorator,
    } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { RUN_GATEWAY } = await import('./tokens.js');
    const { signSessionCookie } = await import('./auth/session-cookie.js');

    const SECRET = 'coexistence-spec-secret-key-abcdefghij';

    @InjectableDecorator()
    class AllowAllGuard implements CanActivate {
      canActivate(_context: ExecutionContext): boolean {
        return true;
      }
    }

    @GlobalDecorator()
    @ModuleDecorator({
      providers: [{ provide: RUN_GATEWAY, useValue: {} }],
      exports: [RUN_GATEWAY],
    })
    class HostGatewayModule {}

    @ModuleDecorator({
      imports: [
        HostGatewayModule,
        DurableDashboardModule.forRoot({
          dashboardAuth: { secret: SECRET, login: () => null },
          guards: [AllowAllGuard],
        }),
      ],
    })
    class HostRootModule {}

    const app = await NestFactory.createApplicationContext(HostRootModule, {
      logger: false,
      abortOnError: false,
    });

    const apiSessionGuard = app.get(DurableApiSessionGuard);
    const allowAllGuard = app.get(AllowAllGuard);
    const validCookie = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: 60_000 });
    const request = { headers: { cookie: `durable_dashboard_session=${validCookie}` } };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ getHeader: () => undefined, setHeader: () => undefined }),
      }),
    } as unknown as ExecutionContext;

    await expect(apiSessionGuard.canActivate(context)).resolves.toBe(true);
    expect(allowAllGuard.canActivate(context)).toBe(true);

    await app.close();
  });
});

describe('DurableDashboardModule.forRootAsync', () => {
  it('always mounts the auth controller + built-in guards (resolved lazily at runtime)', () => {
    const dynamicModule = DurableDashboardModule.forRootAsync({
      useDashboardAuth: () => undefined,
    });

    expect(dynamicModule.controllers).toContain(DurableAuthController);
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, DurableUiController)).toEqual([
      DurableUiSessionGuard,
    ]);
  });

  it('resolves dashboardAuth via an injected factory (DI-backed login hook)', async () => {
    const {
      Inject,
      Module: ModuleDecorator,
      Injectable: InjectableDecorator,
      Global: GlobalDecorator,
    } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { RUN_GATEWAY } = await import('./tokens.js');
    const { DASHBOARD_AUTH } = await import('./auth/dashboard-auth-config.js');

    @InjectableDecorator()
    class UserService {
      verify(username: string, password: string) {
        return username === 'ops' && password === 'secret' ? { id: 'ops' } : null;
      }
    }

    @ModuleDecorator({ providers: [UserService], exports: [UserService] })
    class HostUserModule {}

    @GlobalDecorator()
    @ModuleDecorator({
      providers: [{ provide: RUN_GATEWAY, useValue: {} }],
      exports: [RUN_GATEWAY],
    })
    class HostGatewayModule {}

    @ModuleDecorator({
      imports: [
        HostGatewayModule,
        DurableDashboardModule.forRootAsync({
          imports: [HostUserModule],
          inject: [UserService],
          useDashboardAuth: (users: UserService) => ({
            secret: 'async-spec-secret-key-0123456789abcdef',
            login: (username: string, password: string) => users.verify(username, password),
          }),
        }),
      ],
    })
    class HostRootModule {}

    const app = await NestFactory.createApplicationContext(HostRootModule, {
      logger: false,
      abortOnError: false,
    });

    // Nest already awaited the async `useFactory` during bootstrap, so `app.get` returns the
    // resolved (non-Promise) config here, not a pending one.
    const auth = app.get(DASHBOARD_AUTH);
    expect(auth).not.toBeNull();
    expect(await auth?.login('ops', 'secret')).toEqual({ id: 'ops' });
    expect(await auth?.login('ops', 'wrong')).toBeNull();

    await app.close();
  });
});
