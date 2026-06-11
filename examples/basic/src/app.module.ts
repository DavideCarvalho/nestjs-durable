import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Module } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { CheckoutWorkflow } from './checkout.workflow';
import { PaymentsWorker } from './payments.worker';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    // In-memory store for the example; swap for store-mikro-orm/-typeorm to persist.
    // Event-emitter transport runs step handlers in this process, zero infra.
    DurableModule.forRootAsync({
      inject: [EventEmitter2],
      useFactory: (emitter: EventEmitter2) => ({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(emitter),
        timerPollMs: 50,
      }),
    }),
  ],
  providers: [CheckoutWorkflow, PaymentsWorker],
})
export class AppModule {}
