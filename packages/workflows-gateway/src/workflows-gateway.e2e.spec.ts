import 'reflect-metadata';
import { DurableDashboardModule } from '@dudousxd/nestjs-durable-dashboard';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  ManualWorkflowClock,
  NonRetryableStepError,
  Workflow,
  WorkflowClient,
  type WorkflowContext,
  WorkflowWorker,
  WorkflowsModule,
} from '@nestjs/workflows';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableWorkflowsGatewayModule, WorkflowsRunGateway } from './index';

/**
 * The durable console over the OFFICIAL engine: `WorkflowsModule` on its in-memory store with a
 * manual clock and no background worker (`drain()` runs due instances), the dashboard mounted over
 * HTTP, and this package binding its `RunGateway`.
 */

let shouldFail = true;

@Workflow('greet')
@Injectable()
class GreetWorkflow {
  async run(ctx: WorkflowContext, input: { name: string }) {
    return ctx.step('compose', () => `hello ${input.name}`);
  }
}

@Workflow('charge')
@Injectable()
class ChargeWorkflow {
  async run(ctx: WorkflowContext) {
    return ctx.step(
      'charge-card',
      () => {
        if (shouldFail) throw new NonRetryableStepError('card declined');
        return 'charged';
      },
      { retry: false },
    );
  }
}

@Workflow('approval')
@Injectable()
class ApprovalWorkflow {
  async run(ctx: WorkflowContext, input: { orderId: string }) {
    await ctx.step('notify', () => 'sent');
    const decision = await ctx.waitForSignal<{ ok: boolean }>('decision', 'approve', {
      key: input.orderId,
    });
    return decision;
  }
}

@Workflow('parent')
@Injectable()
class ParentWorkflow {
  async run(ctx: WorkflowContext) {
    const child = await ctx.executeChild(GreetWorkflow, { name: 'child' }, { id: 'kid-1' });
    return { child };
  }
}

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  shouldFail = true;
});

async function boot() {
  const clock = new ManualWorkflowClock(Date.parse('2026-11-01T00:00:00Z'));
  @Module({
    imports: [
      WorkflowsModule.forRoot({ clock, worker: false }),
      DurableWorkflowsGatewayModule.forRoot(),
      DurableDashboardModule.forRoot(),
    ],
    providers: [GreetWorkflow, ChargeWorkflow, ApprovalWorkflow, ParentWorkflow],
  })
  class HostModule {}
  app = await NestFactory.create<NestExpressApplication>(HostModule, { logger: false });
  await app.init();
  const client = app.get(WorkflowClient);
  const worker = app.get(WorkflowWorker);
  const http = app.getHttpServer();
  const tick = async () => {
    clock.advance(1);
    await worker.drain();
  };
  await client.start(GreetWorkflow, { name: 'ada' }, { id: 'done-1' });
  await client.start(ChargeWorkflow, {}, { id: 'failed-1' });
  await client.start(ApprovalWorkflow, { orderId: 'o-1' }, { id: 'wait-1' });
  await client.start(ParentWorkflow, {}, { id: 'parent-1' });
  await tick();
  await tick();
  return { client, http, tick, gateway: app.get(WorkflowsRunGateway) };
}

describe('the durable console over @nestjs/workflows', () => {
  it('lists completed, failed, waiting and parent/child instances with mapped statuses', async () => {
    const { http } = await boot();
    const res = await request(http).get('/durable/api/runs').expect(200);
    const rows = res.body.runs ?? res.body;
    const byId = Object.fromEntries(
      (rows as Array<{ id: string; status: string; waiting?: unknown }>).map((r) => [r.id, r]),
    );
    expect(byId['done-1']?.status).toBe('completed');
    expect(byId['failed-1']?.status).toBe('failed');
    expect(byId['wait-1']?.status).toBe('suspended');
    expect(byId['wait-1']?.waiting).toEqual({ on: 'signal', name: 'approve (key o-1)' });
    expect(byId['parent-1']?.status).toBe('completed');
    expect(byId['kid-1']?.status).toBe('completed');
  });

  it('serves a run detail: the journal as a timeline, and the children', async () => {
    const { http } = await boot();
    const done = (await request(http).get('/durable/api/runs/done-1').expect(200)).body;
    expect(done.run).toMatchObject({ id: 'done-1', workflow: 'greet', output: 'hello ada' });
    expect(done.timeline.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ['compose', 'completed'],
    ]);

    const failed = (await request(http).get('/durable/api/runs/failed-1').expect(200)).body;
    expect(failed.run.error.message).toContain('card declined');
    expect(failed.timeline[0]).toMatchObject({ name: 'charge-card', status: 'failed' });

    const waiting = (await request(http).get('/durable/api/runs/wait-1').expect(200)).body;
    expect(waiting.timeline.map((s: { name: string }) => s.name)).toEqual([
      'notify',
      'signal:decision',
    ]);

    const parent = (await request(http).get('/durable/api/runs/parent-1').expect(200)).body;
    expect(parent.children).toEqual(['kid-1']);
    expect(parent.run.output).toEqual({ child: 'hello child' });

    await request(http).get('/durable/api/runs/nope').expect(404);
  });

  it('counts per status for the status chips', async () => {
    const { http } = await boot();
    const facets = (await request(http).get('/durable/api/runs/facets').expect(200)).body;
    const count = (status: string) =>
      (facets as Array<{ status: string; count: number }>)
        .filter((f) => f.status === status)
        .reduce((n, f) => n + f.count, 0);
    expect(count('completed')).toBe(3);
    expect(count('failed')).toBe(1);
    expect(count('suspended')).toBe(1);
  });

  it('declares what it cannot serve, so the SPA hides those controls', async () => {
    const { http } = await boot();
    const topology = (await request(http).get('/durable/api/topology').expect(200)).body;
    expect(topology.engine).toBe('@nestjs/workflows');
    expect(topology.capabilities).toMatchObject({
      searchAttributes: false,
      breakpoints: false,
      origins: false,
      schedules: false,
      workers: false,
    });
  });

  it('cancel from the console reaches the official engine (compensating cancel)', async () => {
    const { http, client, tick } = await boot();
    await request(http).post('/durable/api/runs/wait-1/cancel?compensate=true').expect(201);
    await tick();
    expect((await client.getStatus('wait-1'))?.status).toBe('cancelled');
    expect((await client.getStatus('wait-1'))?.terminateRequested).toBe(false);
  });

  it('plain cancel is a terminate', async () => {
    const { http, client, tick } = await boot();
    await request(http).post('/durable/api/runs/wait-1/cancel').expect(201);
    await tick();
    const instance = await client.getStatus('wait-1');
    expect(instance?.status).toBe('cancelled');
    expect(instance?.terminateRequested).toBe(true);
  });

  it('retry from the console reopens a failed instance on the official engine', async () => {
    const { http, client, tick } = await boot();
    shouldFail = false;
    const res = await request(http).post('/durable/api/runs/failed-1/retry').expect(201);
    expect(res.body.runId).toBe('failed-1');
    await tick();
    const instance = await client.getStatus('failed-1');
    expect(instance?.status).toBe('completed');
    expect(instance?.output).toBe('charged');
  });

  it('a signal sent to the official engine shows on the console', async () => {
    const { http, client, tick } = await boot();
    await client.signal('approve', { ok: true }, { key: 'o-1' });
    await tick();
    const detail = (await request(http).get('/durable/api/runs/wait-1').expect(200)).body;
    expect(detail.run.status).toBe('completed');
    expect(detail.run.output).toEqual({ ok: true });
  });

  it('streams the official lifecycle events of a run as engine events', async () => {
    const { client, tick, gateway } = await boot();
    const seen: string[] = [];
    const off = gateway.subscribe('wait-1', (e) => seen.push(e.type));
    await client.signal('approve', { ok: false }, { key: 'o-1' });
    await tick();
    off();
    expect(seen).toContain('run.started');
    expect(seen).toContain('run.completed');
  });
});
