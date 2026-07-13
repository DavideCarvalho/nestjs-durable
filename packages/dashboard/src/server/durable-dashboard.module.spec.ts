import 'reflect-metadata';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { GUARDS_METADATA as REAL_GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { DurableApiController } from './durable-api.controller.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';
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
