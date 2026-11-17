import {
  DURABLE_OPTIONS_CANONICAL,
  type RunAppTopologyOptions,
  WorkflowEngine,
  controlPlaneAttribution,
} from '@dudousxd/nestjs-durable-core';
import {
  type DynamicModule,
  Global,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { attachDurableDiagnostics } from './attach-durable-diagnostics';

/**
 * Resolves the already-constructed engine from the container on bootstrap and attaches the
 * diagnostics bridge; detaches on shutdown. Does not construct or own the engine.
 *
 * On a `topology: 'control-plane'` it attaches with tenant attribution, so each tenant run's events
 * name their app. A store-less tenant pod has no local event stream (its `WorkflowEngine` is a
 * start-only client): it emits nothing, and the control plane records its runs instead.
 */
@Injectable()
class DurableDiagnosticsAttacher implements OnApplicationBootstrap, OnApplicationShutdown {
  private off: (() => void) | null = null;

  constructor(private readonly moduleRef: ModuleRef) {}

  onApplicationBootstrap(): void {
    const engine = this.moduleRef.get(WorkflowEngine, { strict: false });
    if (typeof (engine as Partial<WorkflowEngine> | undefined)?.subscribe !== 'function') return;
    const tenants = controlPlaneAttribution(this.durableOptions(), (runId) => engine.getRun(runId));
    this.off = tenants
      ? attachDurableDiagnostics(engine, { tenants })
      : attachDurableDiagnostics(engine);
  }

  /** `DurableModule`'s resolved options, when it is in the app. */
  private durableOptions(): RunAppTopologyOptions | undefined {
    try {
      return this.moduleRef.get<RunAppTopologyOptions>(DURABLE_OPTIONS_CANONICAL, {
        strict: false,
      });
    } catch {
      return undefined;
    }
  }

  onApplicationShutdown(): void {
    this.off?.();
    this.off = null;
  }
}

/**
 * Import once at the app root (alongside `DurableModule`) to put durable on the Aviary diagnostics
 * bus — every run/step event is then observable via `@OnDiagnostic('durable', ...)` or any
 * `getChannel('durable', ...)` subscriber, with no extra dependencies.
 *
 * ```ts
 * @Module({ imports: [DurableModule.forRoot({ ... }), DurableDiagnosticsModule.forRoot()] })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({})
export class DurableDiagnosticsModule {
  static forRoot(): DynamicModule {
    return {
      module: DurableDiagnosticsModule,
      providers: [DurableDiagnosticsAttacher],
    };
  }
}
