// One process of the two-process spec: the same app booted as diagnostics `role: 'api'` (emits) or
// `role: 'worker'` (runs listener deliveries). Real Postgres store, real DB transport. Driven by the
// parent over IPC; every listener call is appended to a shared log file.
import 'reflect-metadata';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit } from '@dudousxd/nestjs-diagnostics';
import {
  type DeliveredEvent,
  DiagnosticsModule,
  OnDiagnostic,
  transports,
} from '@dudousxd/nestjs-diagnostics/nestjs';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { ENTITIES, TypeOrmStateStore } from '@dudousxd/nestjs-durable-store-typeorm';
import { DbTransport, typeOrmExecutor } from '@dudousxd/nestjs-durable-transport-db';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource, type DataSourceOptions } from 'typeorm';

const role = process.env.DIAG_ROLE as 'api' | 'worker';
const workDir = process.env.DIAG_WORK_DIR as string;
const pgOptions = JSON.parse(process.env.DIAG_PG_OPTIONS as string) as DataSourceOptions;
const prefix = process.env.DIAG_TRANSPORT_PREFIX as string;

interface OrderPlaced {
  nonce: string;
  failOnce?: boolean;
}

/** One line per listener call: `<role> <pid> <event id> <nonce> <ok|throw>`. */
function record(event: DeliveredEvent<OrderPlaced>, outcome: 'ok' | 'throw'): void {
  appendFileSync(
    join(workDir, 'calls.log'),
    `${role} ${process.pid} ${event.id} ${event.payload.nonce} ${outcome}\n`,
  );
}

@Injectable()
class OrderListeners {
  @OnDiagnostic('orders', 'placed')
  async onPlaced(event: DeliveredEvent<OrderPlaced>): Promise<void> {
    // The first call in any process throws; a retry, wherever it runs, succeeds.
    if (event.payload.failOnce && isFirstCall(event.id)) {
      record(event, 'throw');
      throw new Error('first attempt fails');
    }
    record(event, 'ok');
  }
}

/** Whether this is the first call for `eventId` across processes (an exclusive marker file). */
function isFirstCall(eventId: string): boolean {
  try {
    writeFileSync(join(workDir, `failed-${eventId}`), '', { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function main(): Promise<void> {
  const dataSource = new DataSource({ ...pgOptions, entities: [...ENTITIES] });
  await dataSource.initialize();

  @Module({
    imports: [
      DurableModule.forRoot({
        store: new TypeOrmStateStore(dataSource),
        transport: new DbTransport({ executor: typeOrmExecutor(dataSource), prefix, pollMs: 50 }),
        autoSchema: false,
        timerPollMs: 100,
        instanceId: `${role}-${process.pid}`,
      }),
      DiagnosticsModule.forRoot({
        default: 'durable',
        role,
        transports: {
          durable: transports.durable({ retries: 3, backoff: 'fixed', backoffMs: 100 }),
        },
      }),
    ],
    providers: [OrderListeners],
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  process.on('message', (message: { type: string; payload?: OrderPlaced }) => {
    if (message.type === 'emit') emit('orders', 'placed', message.payload);
    if (message.type === 'exit') {
      void app
        .close()
        .then(() => dataSource.destroy())
        .finally(() => process.exit(0));
    }
  });
  process.send?.({ type: 'ready' });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
