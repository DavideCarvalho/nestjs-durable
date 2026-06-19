import { type DiagnosticEvent, getChannel, resetRegistry } from '@dudousxd/nestjs-diagnostics';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { afterEach, describe, expect, it } from 'vitest';
import { attachDurableDiagnostics } from './attach-durable-diagnostics';

/** Subscribe to one durable channel and collect the payloads it receives. Returns the captured
 *  array plus an unsubscribe to call in afterEach. */
function capture(event: string) {
  const seen: unknown[] = [];
  const listener = (msg: unknown) => seen.push((msg as DiagnosticEvent).payload);
  const channel = getChannel('durable', event);
  channel.subscribe(listener);
  return { seen, off: () => channel.unsubscribe(listener) };
}

describe('attachDurableDiagnostics', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    resetRegistry();
  });

  it('emits run.started on aviary:durable:run.started with the EngineEvent payload', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    cleanups.push(attachDurableDiagnostics(engine));
    const started = capture('run.started');
    cleanups.push(started.off);

    engine.register('checkout', '1', async () => 'ok');
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    expect(started.seen.length).toBeGreaterThanOrEqual(1);
    const ev = started.seen[0] as { type: string; runId: string; workflow?: string; at: Date };
    expect(ev.type).toBe('run.started');
    expect(ev.runId).toBe('run1');
    expect(ev.workflow).toBe('checkout');
    expect(ev.at).toBeInstanceOf(Date);
  });

  it('emits step.completed with the step name/seq', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    cleanups.push(attachDurableDiagnostics(engine));
    const step = capture('step.completed');
    cleanups.push(step.off);

    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('charge', async () => 1);
      return 'ok';
    });
    await engine.start('checkout', {}, 'run2');
    await engine.waitForRun('run2');

    expect(step.seen.length).toBeGreaterThanOrEqual(1);
    const ev = step.seen[0] as { type: string; name?: string };
    expect(ev.type).toBe('step.completed');
    expect(ev.name).toBe('charge');
  });

  it('emits run.failed carrying the error', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    cleanups.push(attachDurableDiagnostics(engine));
    const failed = capture('run.failed');
    cleanups.push(failed.off);

    engine.register('boom', '1', async () => {
      throw new Error('kaboom');
    });
    await engine.start('boom', {}, 'run3');
    await engine.waitForRun('run3').catch(() => undefined);

    expect(failed.seen.length).toBeGreaterThanOrEqual(1);
    const ev = failed.seen[0] as { type: string; error?: { message?: string } };
    expect(ev.type).toBe('run.failed');
    expect(ev.error?.message).toContain('kaboom');
  });

  it('stops emitting after the returned unsubscribe is called', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const off = attachDurableDiagnostics(engine);
    const started = capture('run.started');
    cleanups.push(started.off);
    off(); // detach the bridge

    engine.register('checkout', '1', async () => 'ok');
    await engine.start('checkout', {}, 'run4');
    await engine.waitForRun('run4');

    expect(started.seen.length).toBe(0);
  });

  it('is zero-cost and never throws when no channel is subscribed', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    cleanups.push(attachDurableDiagnostics(engine)); // attached, but nobody subscribes a channel

    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('charge', async () => 1);
      return 'ok';
    });
    await engine.start('checkout', {}, 'run5');
    await expect(engine.waitForRun('run5')).resolves.toBeDefined();
  });
});
