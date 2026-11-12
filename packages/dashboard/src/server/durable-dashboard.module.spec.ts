import 'reflect-metadata';
import type { CanActivate, DynamicModule, ExecutionContext } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DurableApiController } from './durable-api.controller.js';
import { DurableApiModule, DurableDashboardModule } from './durable-dashboard.module.js';

/** The API controller one registration mounts (a per-registration subclass of the exported one). */
function mountedApi(dashboard: DynamicModule): typeof DurableApiController {
  const api = dashboard.imports?.find(
    (entry) => (entry as DynamicModule | undefined)?.module === DurableApiModule,
  ) as DynamicModule;
  return api.controllers?.[0] as typeof DurableApiController;
}

describe('DurableDashboardModule.forRoot imports', () => {
  it('passes an `imports` passthrough into the dynamic module for guard-dependency resolution', () => {
    class FakeAuthModule {}

    const dynamicModule = DurableDashboardModule.forRoot({ imports: [FakeAuthModule] });

    expect(dynamicModule.imports).toContain(FakeAuthModule);
  });

  it('omitting `imports` still returns a valid dynamic module', () => {
    const dynamicModule = DurableDashboardModule.forRoot();
    expect(dynamicModule.imports?.length).toBeGreaterThan(0);
  });
});

describe('guard DI resolution in the API controller host module', () => {
  // Guards are DI-instantiated by the CONTROLLER's host module. DurableApiController lives in
  // DurableApiModule, so a `UseGuards(...)` passed through `decorators` whose guard has
  // dependencies only resolves if the host's `imports` reach that module too; otherwise boot fails
  // with "Nest can't resolve dependencies of the <Guard> ... in the DurableApiModule context".
  it('threads host imports into the API module so a `decorators` guard with deps resolves', async () => {
    const {
      Inject,
      Module: ModuleDecorator,
      Injectable: InjectableDecorator,
      Global: GlobalDecorator,
    } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { RunGateway } = await import('@dudousxd/nestjs-durable-core');

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
      providers: [{ provide: RunGateway, useValue: {} }],
      exports: [RunGateway],
    })
    class HostGatewayModule {}

    @ModuleDecorator({
      imports: [
        HostGatewayModule,
        DurableDashboardModule.forRoot({
          decorators: [UseGuards(GuardWithDeps)],
          imports: [HostAuthModule],
        }),
      ],
    })
    class HostRootModule {}

    // `createApplicationContext` (not `create`) builds and resolves the FULL DI graph — including
    // every controller's constructor injection — without needing an HTTP adapter (this package has no
    // `@nestjs/platform-express` dependency, unlike a real host app). It still throws "Nest can't
    // resolve dependencies ... in the DurableApiModule context" if the host imports did not land
    // there, which is the only thing this test is proving.
    const app = await NestFactory.createApplicationContext(HostRootModule, {
      logger: false,
      abortOnError: false,
    });
    await app.close();
  });
});

describe('the console composes with a host that has its OWN filter adapter', () => {
  // The console's run filters are written with `@dudousxd/nestjs-filter`, and so are many host
  // apps' — against their ORM. Both must work, in one process, with neither shadowing the other:
  // `FilterModule.forRoot` is GLOBAL, so a library that called it would fight the host over one set
  // of module options and add a second app-wide interceptor. This module wires its own privately.
  it('answers from the run gateway while the host keeps its global adapter', async () => {
    const { Module: ModuleDecorator, Global: GlobalDecorator } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { FilterModule, FilterRunner } = await import('@dudousxd/nestjs-filter');
    const { RunGateway } = await import('@dudousxd/nestjs-durable-core');

    // A host adapter that would answer WRONGLY for a run query — if the console ever reached for
    // the global adapter, these calls would be non-empty and the run list would come from an ORM
    // that has never heard of a workflow run.
    const hostAdapterCalls: string[] = [];
    const hostAdapter = {
      useFactory: () => ({
        createQueryBuilder: () => {
          hostAdapterCalls.push('createQueryBuilder');
          return {};
        },
        applyColumnFilters: () => {
          hostAdapterCalls.push('applyColumnFilters');
        },
        groupByCount: async () => {
          hostAdapterCalls.push('groupByCount');
          return [];
        },
      }),
      inject: [],
    };

    const valueFacetCalls: unknown[] = [];
    @GlobalDecorator()
    @ModuleDecorator({
      providers: [
        {
          provide: RunGateway,
          useValue: {
            async runValueFacets(axis: unknown) {
              valueFacetCalls.push(axis);
              return [{ value: 'etl', count: 2 }];
            },
          },
        },
      ],
      exports: [RunGateway],
    })
    class HostGatewayModule {}

    const dashboard = DurableDashboardModule.forRoot();
    @ModuleDecorator({
      imports: [HostGatewayModule, FilterModule.forRoot({ adapter: hostAdapter }), dashboard],
    })
    class HostRootModule {}

    const app = await NestFactory.createApplicationContext(HostRootModule, {
      logger: false,
      abortOnError: false,
    });

    const controller = app.get(mountedApi(dashboard), { strict: false });
    const values = await controller.values({ groupByCount: { field: 'tag' } });

    // The console's query reached the run gateway through its OWN adapter…
    expect(values).toEqual([{ value: 'etl', count: 2 }]);
    expect(valueFacetCalls).toEqual([{ field: 'tag' }]);
    // …and the host's global adapter was never asked to answer it.
    expect(hostAdapterCalls).toEqual([]);
    // The host's own runner is still there, and is not the console's private one.
    expect(app.get(FilterRunner, { strict: false })).toBeDefined();

    await app.close();
  });

  it('works just as well in an app that has never heard of the filter library', async () => {
    // The other half of the same property: the console brings its own runner and interceptor, so a
    // host that never registers `FilterModule` gets a working run list rather than a boot error.
    const { Module: ModuleDecorator, Global: GlobalDecorator } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { RunGateway } = await import('@dudousxd/nestjs-durable-core');

    @GlobalDecorator()
    @ModuleDecorator({
      providers: [
        {
          provide: RunGateway,
          useValue: {
            async runValueFacets() {
              return [{ value: 'acme', count: 1 }];
            },
          },
        },
      ],
      exports: [RunGateway],
    })
    class HostGatewayModule {}

    const dashboard = DurableDashboardModule.forRoot();
    @ModuleDecorator({ imports: [HostGatewayModule, dashboard] })
    class HostRootModule {}

    const app = await NestFactory.createApplicationContext(HostRootModule, {
      logger: false,
      abortOnError: false,
    });

    const controller = app.get(mountedApi(dashboard), { strict: false });
    expect(await controller.values({ groupByCount: { field: 'namespace' } })).toEqual([
      { value: 'acme', count: 1 },
    ]);

    await app.close();
  });
});
