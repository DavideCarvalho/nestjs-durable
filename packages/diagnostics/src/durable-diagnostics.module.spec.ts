import 'reflect-metadata';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Isolate the module's responsibility (resolve the engine + attach on bootstrap, detach on
// shutdown) from the bridge's behavior (covered by attach-durable-diagnostics.spec.ts). Mocking the
// bridge lets us assert the module calls attach with the container's engine and calls the returned
// unsubscribe on shutdown — independent of engine draining, which otherwise silences channel events
// for the wrong reason and makes a shutdown test pass vacuously.
const { attachSpy, offSpy } = vi.hoisted(() => {
  const offSpy = vi.fn();
  return { offSpy, attachSpy: vi.fn(() => offSpy) };
});
vi.mock('./attach-durable-diagnostics', () => ({ attachDurableDiagnostics: attachSpy }));

import { DurableDiagnosticsModule } from './durable-diagnostics.module';

async function bootApp() {
  const store = new InMemoryStateStore();
  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ store }), DurableDiagnosticsModule.forRoot()],
  }).compile();
  await moduleRef.init(); // fires onApplicationBootstrap
  return moduleRef;
}

describe('DurableDiagnosticsModule', () => {
  afterEach(() => {
    attachSpy.mockClear();
    offSpy.mockClear();
  });

  it('resolves the engine and attaches the bridge on bootstrap', async () => {
    const moduleRef = await bootApp();
    try {
      expect(attachSpy).toHaveBeenCalledTimes(1);
      expect(attachSpy).toHaveBeenCalledWith(moduleRef.get(WorkflowEngine, { strict: false }));
    } finally {
      await moduleRef.close();
    }
  });

  it('calls the unsubscribe returned by attach on shutdown', async () => {
    const moduleRef = await bootApp();
    expect(offSpy).not.toHaveBeenCalled();
    await moduleRef.close(); // fires onApplicationShutdown
    expect(offSpy).toHaveBeenCalledTimes(1);
  });
});
