import 'reflect-metadata';
import {
  InMemoryStateStore,
  RunGateway,
  STATE_STORE_CANONICAL,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IdempotencyModule, Idempotent } from '@nestjs/idempotency';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableDashboardModule } from './durable-dashboard.module.js';

/**
 * The recipe the docs give: `@nestjs/idempotency`'s `Idempotent()` passed through the console's
 * `decorators`. On a class it covers every state-changing handler (POST here), so a client retry
 * carrying the same `Idempotency-Key` runs retry / cancel / the webhook receiver once and gets the
 * stored response. Durable itself takes no dependency on the package.
 */

const calls = { retry: 0, cancel: 0 };
const gateway = {
  async retry(runId: string) {
    calls.retry += 1;
    return { runId, status: 'pending' };
  },
  async cancel(runId: string) {
    calls.cancel += 1;
    return { runId, status: 'cancelled' };
  },
};

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  calls.retry = 0;
  calls.cancel = 0;
});

async function boot() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  let webhookDeliveries = 0;
  engine.register('wf', '1', async (ctx) => {
    const wh = ctx.webhook<{ n: number }>();
    return wh.wait();
  });
  const signal = engine.signal.bind(engine);
  engine.signal = async (token, payload) => {
    webhookDeliveries += 1;
    return signal(token, payload);
  };

  @Global()
  @Module({
    providers: [
      { provide: RunGateway, useValue: gateway },
      { provide: STATE_STORE_CANONICAL, useValue: store },
      { provide: WorkflowEngine, useValue: engine },
    ],
    exports: [RunGateway, STATE_STORE_CANONICAL, WorkflowEngine],
  })
  class HostDurableModule {}

  @Module({
    imports: [
      HostDurableModule,
      IdempotencyModule.forRoot({ scope: false }),
      DurableDashboardModule.forRoot({ decorators: [Idempotent()] }),
    ],
  })
  class HostRootModule {}

  app = await NestFactory.create<NestExpressApplication>(HostRootModule, {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  return { http: app.getHttpServer(), engine, store, webhookDeliveries: () => webhookDeliveries };
}

describe('dashboard POSTs under @Idempotent() (via `decorators`)', () => {
  it('a replayed retry with the same Idempotency-Key retries once and replays the response', async () => {
    const { http } = await boot();
    const first = await request(http)
      .post('/durable/api/runs/r1/retry')
      .set('Idempotency-Key', 'k-retry');
    const replay = await request(http)
      .post('/durable/api/runs/r1/retry')
      .set('Idempotency-Key', 'k-retry');
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(calls.retry).toBe(1);

    // A different key is a different operation.
    await request(http).post('/durable/api/runs/r1/retry').set('Idempotency-Key', 'k-retry-2');
    expect(calls.retry).toBe(2);
  });

  it('a replayed cancel runs once', async () => {
    const { http } = await boot();
    await request(http).post('/durable/api/runs/r1/cancel').set('Idempotency-Key', 'k-cancel');
    await request(http).post('/durable/api/runs/r1/cancel').set('Idempotency-Key', 'k-cancel');
    expect(calls.cancel).toBe(1);
  });

  it('a replayed ctx.webhook() callback is delivered once', async () => {
    const { http, engine, store, webhookDeliveries } = await boot();
    await engine.start('wf', {}, 'r-wh');
    await engine.waitForRun('r-wh');

    const first = await request(http)
      .post('/durable/api/webhooks/wh:r-wh:0')
      .set('Idempotency-Key', 'evt-1')
      .send({ n: 1 });
    const replay = await request(http)
      .post('/durable/api/webhooks/wh:r-wh:0')
      .set('Idempotency-Key', 'evt-1')
      .send({ n: 1 });
    expect(first.status).toBe(201);
    // Without the decorator this replay would 404 (the run has finished); here it is the stored 201.
    expect(replay.status).toBe(201);
    expect(webhookDeliveries()).toBe(1);
    expect((await engine.waitForRun('r-wh')).status).toBe('completed');
    expect((await store.getRun('r-wh'))?.output).toEqual({ n: 1 });
  });

  it('GET routes are not covered: no key needed, nothing stored', async () => {
    const { http } = await boot();
    const res = await request(http).get('/durable/api/runs/does-not-exist');
    expect(res.status).not.toBe(400);
  });
});
