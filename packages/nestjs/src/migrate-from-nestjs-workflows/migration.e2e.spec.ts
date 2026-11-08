import 'reflect-metadata';
import {
  InMemoryStateStore,
  InMemoryTransport,
  type WorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import { DurableDashboardModule } from '@dudousxd/nestjs-durable-dashboard';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  ManualWorkflowClock,
  Workflow as OfficialWorkflow,
  WorkflowClient,
  type WorkflowContext,
  WorkflowWorker,
  WorkflowsModule,
} from '@nestjs/workflows';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Workflow } from '../decorators';
import { DurableModule } from '../durable.module';
import { DurableMigrationModule, MigrationClient } from './index';

/**
 * A cutover in progress: the same `approval` workflow on both engines. The official one was the
 * old home (an instance started there before the cutover keeps running there); new starts go to
 * durable through the router; the console shows both.
 */

@OfficialWorkflow('approval')
@Injectable()
class OfficialApproval {
  async run(ctx: WorkflowContext, input: { orderId: string }) {
    const decision = await ctx.waitForSignal<{ ok: boolean }>('decision', 'approve', {
      key: input.orderId,
    });
    return { engine: 'official', decision };
  }
}

// What `durable migrate nestjs-workflows` makes of it: the signal `approve` + key → token `approve:<key>`.
@Workflow({ name: 'approval' })
@Injectable()
class DurableApproval {
  async run(ctx: WorkflowCtx, input: { orderId: string }) {
    const decision = await ctx.waitForSignal<{ ok: boolean }>(`approve:${input.orderId}`);
    return { engine: 'durable', decision };
  }
}

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot() {
  const clock = new ManualWorkflowClock(Date.parse('2026-11-01T00:00:00Z'));
  @Module({
    imports: [
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new InMemoryTransport(),
        timerPollMs: 0,
      }),
      WorkflowsModule.forRoot({ clock, worker: false }),
      DurableMigrationModule.forRoot(),
      DurableDashboardModule.forRoot({ imports: [DurableMigrationModule.console()] }),
    ],
    providers: [OfficialApproval, DurableApproval],
  })
  class HostModule {}
  app = await NestFactory.create<NestExpressApplication>(HostModule, { logger: false });
  await app.init();
  const official = app.get(WorkflowClient);
  const worker = app.get(WorkflowWorker);
  const router = app.get(MigrationClient);
  const drain = async () => {
    clock.advance(1);
    await worker.drain();
  };
  // Before the cutover: an instance started on the official engine, parked on its signal.
  await official.start(OfficialApproval, { orderId: 'old' }, { id: 'old-1' });
  await drain();
  return { official, router, drain, http: app.getHttpServer() };
}

describe('cutover from @nestjs/workflows through MigrationClient', () => {
  it('new starts go to durable; each id is found in the engine that owns it', async () => {
    const { router, official } = await boot();
    await router.start(DurableApproval, { orderId: 'new' }, 'new-1');
    expect(await router.owner('new-1')).toBe('nestjs-durable');
    expect(await router.owner('old-1')).toBe('@nestjs/workflows');
    expect(await router.owner('nope')).toBeNull();
    expect(await official.getStatus('new-1')).toBeNull(); // nothing new lands on the official engine
  });

  it('an instance started on the official engine before the cutover is signalled and completes through the router', async () => {
    const { router, drain } = await boot();
    expect(await router.getStatus('old-1')).toMatchObject({
      engine: '@nestjs/workflows',
      status: 'suspended',
    });
    expect(await router.remainingOnOfficial()).toBe(1);

    expect(await router.signal('old-1', 'approve', { ok: true }, { key: 'old' })).toBe(
      '@nestjs/workflows',
    );
    await drain();

    expect(await router.result('old-1', { timeoutMs: 2_000 })).toMatchObject({
      engine: '@nestjs/workflows',
      status: 'completed',
      output: { engine: 'official', decision: { ok: true } },
    });
    expect(await router.remainingOnOfficial()).toBe(0); // drained: @nestjs/workflows can go
  });

  it('a new instance runs on durable, signalled by the same call shape', async () => {
    const { router } = await boot();
    await router.start('approval', { orderId: 'new' }, 'new-2');
    expect(await router.signal('new-2', 'approve', { ok: false }, { key: 'new' })).toBe(
      'nestjs-durable',
    );
    expect(await router.result('new-2', { timeoutMs: 2_000 })).toMatchObject({
      engine: 'nestjs-durable',
      status: 'completed',
      output: { engine: 'durable', decision: { ok: false } },
    });
  });

  it('cancel goes to the owner: compensate → official cancel; plain → terminate', async () => {
    const { router, official, drain } = await boot();
    await router.cancel('old-1');
    await drain();
    expect((await official.getStatus('old-1'))?.terminateRequested).toBe(true);
    expect((await router.getStatus('old-1'))?.status).toBe('cancelled');
  });

  it('one console shows both engines, and its actions reach the owner', async () => {
    const { router, http, official, drain } = await boot();
    await router.start(DurableApproval, { orderId: 'new' }, 'new-3');
    await router.result('new-3', { timeoutMs: 50 }).catch(() => undefined); // let it park
    const res = await request(http).get('/durable/api/runs').expect(200);
    const ids = ((res.body.runs ?? res.body) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['old-1', 'new-3']));

    const legacy = (await request(http).get('/durable/api/runs/old-1').expect(200)).body;
    expect(legacy.timeline.map((s: { name: string }) => s.name)).toEqual(['signal:decision']);
    const durable = (await request(http).get('/durable/api/runs/new-3').expect(200)).body;
    expect(durable.run.workflow).toBe('approval');

    const topology = (await request(http).get('/durable/api/topology').expect(200)).body;
    expect(topology.engine).toBe('nestjs-durable + @nestjs/workflows');

    await request(http).post('/durable/api/runs/old-1/cancel?compensate=true').expect(201);
    await drain();
    expect((await official.getStatus('old-1'))?.status).toBe('cancelled');
    expect((await official.getStatus('old-1'))?.terminateRequested).toBe(false);
  });
});
