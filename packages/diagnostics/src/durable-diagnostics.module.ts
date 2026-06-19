import {
  type DynamicModule,
  Global,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { attachDurableDiagnostics } from './attach-durable-diagnostics';

/** Resolves the already-constructed engine from the container on bootstrap and attaches the
 *  diagnostics bridge; detaches on shutdown. Does not construct or own the engine. */
@Injectable()
class DurableDiagnosticsAttacher implements OnApplicationBootstrap, OnApplicationShutdown {
  private off: (() => void) | null = null;

  constructor(private readonly moduleRef: ModuleRef) {}

  onApplicationBootstrap(): void {
    const engine = this.moduleRef.get(WorkflowEngine, { strict: false });
    this.off = attachDurableDiagnostics(engine);
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
