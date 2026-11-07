import 'reflect-metadata';
import { StepWorker } from '@dudousxd/durable-worker';
import type { RemoteTask, StepResult } from '@dudousxd/nestjs-durable-core';
import {
  EventEmitterTransport,
  RESULT_EVENT,
  TASK_EVENT,
} from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ManualWorkflowClock,
  Workflow,
  WorkflowClient,
  type WorkflowContext,
  WorkflowEvents,
  WorkflowWorker,
  WorkflowsModule,
} from '@nestjs/workflows';
import { EventEmitter2 } from 'eventemitter2';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableRemoteStepsModule, RemoteSteps, remoteStep } from './index';

/**
 * `remoteStep` on the OFFICIAL engine (in-memory store, manual clock, `drain()`), dispatching over
 * durable's in-process event-emitter transport to a Node `StepWorker` from `@dudousxd/durable-worker`
 * — the same handler/result wire format the BullMQ and Python workers speak.
 */

const calls: Record<string, number> = {};
let flaky = 0;
/** Results the worker sends twice, to prove a duplicate completes the step once. */
let duplicateResults = false;

function nodeWorker(emitter: EventEmitter2): StepWorker {
  const worker = new StepWorker('payments')
    .register('charge', (input: { amount: number }) => {
      calls.charge = (calls.charge ?? 0) + 1;
      return { charged: input.amount };
    })
    .register('flaky', () => {
      calls.flaky = (calls.flaky ?? 0) + 1;
      if (flaky-- > 0) throw new Error('gateway hiccup');
      return 'ok';
    })
    .register('declined', () => {
      calls.declined = (calls.declined ?? 0) + 1;
      throw Object.assign(new Error('card declined'), { retryable: false });
    });
  emitter.on(TASK_EVENT, async (task: RemoteTask) => {
    // `slow` is never answered: the attempt can only time out.
    if (!worker.handles(task.name)) return;
    const result: StepResult = await worker.processTask(task);
    setImmediate(() => {
      emitter.emit(RESULT_EVENT, result);
      if (duplicateResults) emitter.emit(RESULT_EVENT, result);
    });
  });
  return worker;
}

@Workflow('checkout')
@Injectable()
class CheckoutWorkflow {
  async run(ctx: WorkflowContext, input: { handler: string; retry?: number }) {
    try {
      const out = await remoteStep(ctx, input.handler, {
        group: 'payments',
        input: { amount: 42 },
        timeout: '30s',
        retry: input.retry ?? 1,
      });
      return { ok: true, out };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  for (const k of Object.keys(calls)) delete calls[k];
  flaky = 0;
  duplicateResults = false;
});

async function boot() {
  const emitter = new EventEmitter2();
  const transport = new EventEmitterTransport(emitter);
  nodeWorker(emitter);
  const clock = new ManualWorkflowClock(Date.parse('2026-11-01T00:00:00Z'));
  @Module({
    imports: [
      WorkflowsModule.forRoot({ clock, worker: false }),
      DurableRemoteStepsModule.forRoot({ transport }),
    ],
    providers: [CheckoutWorkflow],
  })
  class HostModule {}
  const app = await NestFactory.createApplicationContext(HostModule, { logger: false });
  close = () => app.close();
  const client = app.get(WorkflowClient);
  const worker = app.get(WorkflowWorker);
  const completions: string[] = [];
  app.get(WorkflowEvents).events$.subscribe((e) => {
    if (e.type === 'workflow-completed') completions.push(e.id);
  });
  /** Let the worker's async result land, then run what is due. */
  const settle = async (rounds = 5) => {
    for (let i = 0; i < rounds; i++) {
      await worker.drain();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await worker.drain();
  };
  return { app, client, clock, settle, completions };
}

describe('remoteStep on @nestjs/workflows', () => {
  it('runs the step on the remote worker and returns its output', async () => {
    const { client, settle } = await boot();
    await client.start(CheckoutWorkflow, { handler: 'charge' }, { id: 'c-1' });
    await settle();
    const instance = await client.getStatus('c-1', { journal: true });
    expect(instance?.status).toBe('completed');
    expect(instance?.output).toEqual({ ok: true, out: { charged: 42 } });
    expect(calls.charge).toBe(1);
    // Dispatch journaled as a step, the wait as one `any` entry: the instance parked in between.
    expect(instance?.journal?.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'step:charge:dispatch#1',
      'any:charge:result#1',
    ]);
  });

  it('a duplicate result completes the step once', async () => {
    duplicateResults = true;
    const { app, client, settle, completions } = await boot();
    await client.start(CheckoutWorkflow, { handler: 'charge' }, { id: 'c-dup' });
    await settle();
    // And a third copy, delivered by hand after the instance finished.
    await app.get(RemoteSteps).deliver({
      runId: 'c-dup',
      seq: 1,
      stepId: 'c-dup:charge#1',
      status: 'completed',
      output: { charged: 999 },
    });
    await settle();
    const instance = await client.getStatus('c-dup');
    expect(instance?.output).toEqual({ ok: true, out: { charged: 42 } });
    expect(completions.filter((id) => id === 'c-dup')).toHaveLength(1);
    expect(calls.charge).toBe(1);
  });

  it('retries a retryable remote failure as a new attempt', async () => {
    flaky = 1;
    const { client, clock, settle } = await boot();
    await client.start(CheckoutWorkflow, { handler: 'flaky', retry: 2 }, { id: 'c-flaky' });
    await settle();
    clock.advance('2s'); // past the journaled backoff before attempt 2
    await settle();
    const instance = await client.getStatus('c-flaky');
    expect(instance?.output).toEqual({ ok: true, out: 'ok' });
    expect(calls.flaky).toBe(2);
  });

  it('a non-retryable remote failure fails the step without retrying', async () => {
    const { client, settle } = await boot();
    await client.start(CheckoutWorkflow, { handler: 'declined', retry: 3 }, { id: 'c-declined' });
    await settle();
    const instance = await client.getStatus('c-declined', { journal: true });
    expect(instance?.status).toBe('completed');
    expect(instance?.output).toMatchObject({ ok: false });
    expect((instance?.output as { error: string }).error).toContain('card declined');
    expect(calls.declined).toBe(1);
    expect(instance?.journal?.find((e) => e.name === 'declined:failed')?.status).toBe('failed');
  });

  it('times out an attempt nobody answers, and fails after the last one', async () => {
    const { client, clock, settle } = await boot();
    await client.start(CheckoutWorkflow, { handler: 'slow', retry: 2 }, { id: 'c-slow' });
    await settle();
    expect((await client.getStatus('c-slow'))?.status).toBe('suspended');
    clock.advance('31s'); // attempt 1 times out → backoff
    await settle();
    clock.advance('2s'); // backoff over → attempt 2 dispatched
    await settle();
    clock.advance('31s'); // attempt 2 times out → give up
    await settle();
    const instance = await client.getStatus('c-slow');
    expect(instance?.status).toBe('completed');
    expect((instance?.output as { error: string }).error).toContain('timed out');
  });
});
