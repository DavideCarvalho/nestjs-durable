import 'reflect-metadata';
import {
  InMemoryStateStore,
  RunGateway,
  STATE_STORE_CANONICAL,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import {
  type CanActivate,
  Controller,
  type DynamicModule,
  Global,
  Injectable,
  Module,
  type Type,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UseConsoleAuthorize } from './console-authorize.js';
import { DurableApiControllerBase } from './durable-api.controller.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';

/** The `ctx.webhook()` callback is not a console route: `authorize` never gates it. */

@Injectable()
class CountingGuard implements CanActivate {
  static calls = 0;
  canActivate(): boolean {
    CountingGuard.calls += 1;
    return true;
  }
}

let app: NestExpressApplication | undefined;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  CountingGuard.calls = 0;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (savedNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
  else process.env.NODE_ENV = savedNodeEnv;
});

/** A control plane with one run parked on `ctx.webhook()`; returns the server and the token. */
async function boot(dashboard: DynamicModule, controllers: Type[] = []) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('pay', '1', async (ctx) => ctx.webhook<{ paid: boolean }>().wait());
  await engine.start('pay', {}, 'r1');
  await engine.waitForRun('r1');
  const gateway = { listRuns: async () => [] } as unknown as RunGateway;

  @Global()
  @Module({
    providers: [
      { provide: RunGateway, useValue: gateway },
      { provide: RunGateway, useValue: gateway },
      { provide: STATE_STORE_CANONICAL, useValue: store },
      { provide: WorkflowEngine, useValue: engine },
      CountingGuard,
    ],
    exports: [RunGateway, RunGateway, STATE_STORE_CANONICAL, WorkflowEngine, CountingGuard],
  })
  class HostDurableModule {}

  @Module({ imports: [HostDurableModule, dashboard], controllers })
  class HostRootModule {}

  app = await NestFactory.create<NestExpressApplication>(HostRootModule, {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  return { server: app.getHttpServer(), store };
}

describe('the webhook route and the console gate', () => {
  it('production with no `authorize`: the webhook is delivered while the console API answers 403', async () => {
    const { server, store } = await boot(DurableDashboardModule.forRoot());
    expect((await request(server).get('/durable/api/runs')).status).toBe(403);

    const delivered = await request(server)
      .post('/durable/api/webhooks/wh:r1:0')
      .send({ paid: true });
    expect(delivered.status).toBe(201);
    expect(delivered.body).toMatchObject({ runId: 'r1' });
    await expect.poll(async () => (await store.getRun('r1'))?.status).toBe('completed');
    expect((await store.getRun('r1'))?.output).toEqual({ paid: true });
  });

  it('a denying `authorize` does not reach the webhook either, and an unknown token is still 404', async () => {
    const { server } = await boot(DurableDashboardModule.forRoot({ authorize: () => false }));
    expect((await request(server).get('/durable/api/runs')).status).toBe(403);
    expect((await request(server).post('/durable/api/webhooks/wh:r1:0').send({})).status).toBe(201);
    expect((await request(server).post('/durable/api/webhooks/wh:nope:0').send({})).status).toBe(
      404,
    );
  });

  it("keeps the app's `decorators` on the webhook route", async () => {
    const { server } = await boot(
      DurableDashboardModule.forRoot({ decorators: [UseGuards(CountingGuard)] }),
    );
    await request(server).post('/durable/api/webhooks/wh:r1:0').send({});
    expect(CountingGuard.calls).toBe(1);
  });

  it('a self-mounted API with @UseConsoleAuthorize() leaves the inherited webhook route open', async () => {
    @Controller('ops/durable/api')
    @UseConsoleAuthorize()
    class OpsApi extends DurableApiControllerBase {}

    const { server } = await boot(
      DurableDashboardModule.forRoot({ routes: false, apiBasePath: '/ops/durable/api' }),
      [OpsApi],
    );
    expect((await request(server).get('/ops/durable/api/runs')).status).toBe(403);
    expect((await request(server).post('/ops/durable/api/webhooks/wh:r1:0').send({})).status).toBe(
      201,
    );
  });
});
