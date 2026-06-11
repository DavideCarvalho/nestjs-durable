import {
  DURABLE_OPTIONS,
  STATE_STORE,
  type StateStore,
  TRANSPORT,
  type Transport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { type DynamicModule, type InjectionToken, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DurableStepRegistrar } from './durable-step.registrar';
import { TimerPoller } from './timer-poller';
import { WorkflowRegistrar } from './workflow.registrar';
import { WorkflowService } from './workflow.service';

export interface DurableModuleOptions {
  store: StateStore;
  transport?: Transport;
  /** Interval (ms) for the durable-timer poller. `0` disables it. Defaults to 1000. */
  timerPollMs?: number;
}

export interface DurableModuleAsyncOptions {
  useFactory: (...args: never[]) => DurableModuleOptions | Promise<DurableModuleOptions>;
  inject?: InjectionToken[];
}

@Module({})
export class DurableModule {
  static forRoot(options: DurableModuleOptions): DynamicModule {
    return DurableModule.build({ provide: DURABLE_OPTIONS, useValue: options });
  }

  static forRootAsync(options: DurableModuleAsyncOptions): DynamicModule {
    return DurableModule.build({
      provide: DURABLE_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    });
  }

  private static build(optionsProvider: Provider): DynamicModule {
    return {
      module: DurableModule,
      imports: [DiscoveryModule],
      providers: [
        optionsProvider,
        {
          provide: STATE_STORE,
          useFactory: (options: DurableModuleOptions) => options.store,
          inject: [DURABLE_OPTIONS],
        },
        {
          provide: TRANSPORT,
          useFactory: (options: DurableModuleOptions) => options.transport ?? null,
          inject: [DURABLE_OPTIONS],
        },
        {
          provide: WorkflowEngine,
          useFactory: (store: StateStore, transport: Transport | null) =>
            new WorkflowEngine({ store, transport: transport ?? undefined }),
          inject: [STATE_STORE, TRANSPORT],
        },
        WorkflowService,
        WorkflowRegistrar,
        DurableStepRegistrar,
        TimerPoller,
      ],
      exports: [WorkflowService, WorkflowEngine],
    };
  }
}
