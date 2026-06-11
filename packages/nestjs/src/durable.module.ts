import {
  STATE_STORE,
  type StateStore,
  TRANSPORT,
  type Transport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { WorkflowRegistrar } from './workflow.registrar';
import { WorkflowService } from './workflow.service';

export interface DurableModuleOptions {
  store: StateStore;
  transport?: Transport;
}

@Module({})
export class DurableModule {
  static forRoot(options: DurableModuleOptions): DynamicModule {
    return {
      module: DurableModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: STATE_STORE, useValue: options.store },
        { provide: TRANSPORT, useValue: options.transport ?? null },
        {
          provide: WorkflowEngine,
          useFactory: (store: StateStore, transport: Transport | null) =>
            new WorkflowEngine({ store, transport: transport ?? undefined }),
          inject: [STATE_STORE, TRANSPORT],
        },
        WorkflowService,
        WorkflowRegistrar,
      ],
      exports: [WorkflowService, WorkflowEngine],
    };
  }
}
