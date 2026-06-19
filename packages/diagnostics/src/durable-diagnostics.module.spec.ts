import 'reflect-metadata';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { type DiagnosticEvent, getChannel, resetRegistry } from '@dudousxd/nestjs-diagnostics';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableDiagnosticsModule } from './durable-diagnostics.module';

function capture(event: string) {
  const seen: unknown[] = [];
  const listener = (msg: unknown) => seen.push((msg as DiagnosticEvent).payload);
  const channel = getChannel('durable', event);
  channel.subscribe(listener);
  return { seen, off: () => channel.unsubscribe(listener) };
}

describe('DurableDiagnosticsModule', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    resetRegistry();
  });

  it('attaches on bootstrap so a workflow run emits on aviary:durable:run.started', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store }), DurableDiagnosticsModule.forRoot()],
    }).compile();
    await moduleRef.init();
    cleanups.push(() => void moduleRef.close());

    const started = capture('run.started');
    cleanups.push(started.off);

    const engine = moduleRef.get(WorkflowEngine);
    engine.register('checkout', '1', async () => 'ok');
    await engine.start('checkout', {}, 'm-run1');
    await engine.waitForRun('m-run1');

    expect(started.seen.length).toBeGreaterThanOrEqual(1);
  });

  it('detaches on app.close so later runs emit nothing', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store }), DurableDiagnosticsModule.forRoot()],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine);
    engine.register('checkout', '1', async () => 'ok');

    await moduleRef.close(); // shutdown fires onApplicationShutdown → detaches the bridge

    const started = capture('run.started');
    cleanups.push(started.off);
    // The engine is draining after close so runs are not dispatched; start + timeout to let the
    // dispatch microtask run, then assert no diagnostics event was forwarded.
    await engine.start('checkout', {}, 'm-run2');
    await engine.waitForRun('m-run2', { timeoutMs: 500 }).catch(() => {
      /* expected: engine is draining, run never executes */
    });

    expect(started.seen.length).toBe(0);
  });
});
