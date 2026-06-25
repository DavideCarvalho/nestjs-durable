import type { RemoteTask } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { StepWorker } from './step-worker';

function task(over: Partial<RemoteTask> = {}): RemoteTask {
  return {
    runId: 'r1',
    seq: 0,
    name: 'do',
    stepId: 'step-0',
    group: 'steps',
    input: null,
    attempt: 1,
    ...over,
  };
}

describe('StepWorker.processTask', () => {
  it('maps a completed handler to a completed StepResult with output + startedAt', async () => {
    const w = new StepWorker();
    w.register('do', (input: { n: number }) => input.n * 2);
    const r = await w.processTask(task({ input: { n: 21 } }));
    expect(r.status).toBe('completed');
    expect(r.output).toBe(42);
    expect(r.runId).toBe('r1');
    expect(r.seq).toBe(0);
    expect(r.stepId).toBe('step-0');
    expect(typeof r.startedAt).toBe('number');
  });

  it('awaits an async handler', async () => {
    const w = new StepWorker();
    w.register('do', async (input: { n: number }) => input.n + 1);
    const r = await w.processTask(task({ input: { n: 1 } }));
    expect(r.status).toBe('completed');
    expect(r.output).toBe(2);
  });

  it('maps a throwing handler to a failed StepResult with the error', async () => {
    const w = new StepWorker();
    w.register('do', () => {
      throw new Error('kaboom');
    });
    const r = await w.processTask(task());
    expect(r.status).toBe('failed');
    expect(r.error?.message).toBe('kaboom');
    expect(typeof r.startedAt).toBe('number');
  });

  it('fails cleanly with "no handler" for an unknown name', async () => {
    const w = new StepWorker();
    const r = await w.processTask(task({ name: 'nope' }));
    expect(r.status).toBe('failed');
    expect(r.error?.message).toBe('no handler for nope');
    expect(r.stepId).toBe('step-0');
  });

  it('captures handler-emitted events onto the StepResult', async () => {
    const w = new StepWorker();
    w.register('do', (_input, log) => {
      log.info('working');
      log.sub('p1', 'ok');
      return 1;
    });
    const r = await w.processTask(task());
    expect(r.status).toBe('completed');
    expect(r.events).toHaveLength(2);
    expect(r.events?.[0].message).toBe('working');
    expect(r.events?.[1].name).toBe('p1');
    expect(r.events?.[1].status).toBe('ok');
  });

  it('propagates a non-retryable verdict off a thrown error', async () => {
    const w = new StepWorker();
    w.register('do', () => {
      throw Object.assign(new Error('declined'), { retryable: false });
    });
    const r = await w.processTask(task());
    expect(r.status).toBe('failed');
    expect(r.error?.message).toBe('declined');
    expect(r.error?.retryable).toBe(false);
  });

  it('propagates an explicit retryable verdict off a thrown error', async () => {
    const w = new StepWorker();
    w.register('do', () => {
      throw Object.assign(new Error('try again'), { retryable: true });
    });
    const r = await w.processTask(task());
    expect(r.status).toBe('failed');
    expect(r.error?.retryable).toBe(true);
  });

  it('leaves retryable unset for a plain thrown error (engine default retries)', async () => {
    const w = new StepWorker();
    w.register('do', () => {
      throw new Error('oops');
    });
    const r = await w.processTask(task());
    expect(r.status).toBe('failed');
    expect(r.error?.retryable).toBeUndefined();
  });

  it('keeps events the handler logged before it threw', async () => {
    const w = new StepWorker();
    w.register('do', (_input, log) => {
      log.warn('about to fail');
      throw new Error('boom');
    });
    const r = await w.processTask(task());
    expect(r.status).toBe('failed');
    expect(r.events?.[0].message).toBe('about to fail');
  });
});
