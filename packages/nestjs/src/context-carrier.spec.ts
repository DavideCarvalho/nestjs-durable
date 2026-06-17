import {
  InMemoryStateStore,
  type RemoteTask,
  type StepResult,
  type Transport,
  type WorkflowCtx,
  remoteStep,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ContextAccessor, UserRef } from './context-accessor';
import { Workflow } from './decorators';
import { DurableModule, type DurableModuleOptions } from './durable.module';
import { CONTEXT_ACCESSOR } from './tokens';
import { WorkflowService } from './workflow.service';

/** A remote step the workflow dispatches — the carrier rides on its dispatched task. */
const ping = remoteStep({
  name: 'ext.ping',
  group: 'ext',
  input: z.object({}),
  output: z.object({ pong: z.boolean() }),
});

@Workflow({ name: 'wf', version: '1' })
class Wf {
  async run(ctx: WorkflowCtx) {
    await ctx.call(ping, {});
    return 'x';
  }
}

/** A recording transport: captures each dispatched task and immediately completes it. */
function recordingTransport(dispatched: RemoteTask[]): Transport {
  let onResult: ((r: StepResult) => Promise<void>) | undefined;
  return {
    async dispatch(task) {
      dispatched.push(task);
      const result: StepResult = {
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output: { pong: true },
      };
      setImmediate(() => void onResult?.(result));
    },
    onResult(handler) {
      onResult = handler;
    },
    onHeartbeat() {},
  };
}

/** A fake structural ContextAccessor — no nestjs-context dependency. */
function fakeAccessor(values: {
  traceId?: string;
  tenantId?: string;
  userRef?: UserRef;
}): ContextAccessor {
  return {
    traceId: () => values.traceId,
    tenantId: () => values.tenantId,
    userRef: () => values.userRef,
    get: () => undefined,
  };
}

async function buildModule(
  options: DurableModuleOptions,
  accessor?: ContextAccessor,
): Promise<{ service: WorkflowService; close: () => Promise<void> }> {
  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot(options)],
    providers: [Wf, ...(accessor ? [{ provide: CONTEXT_ACCESSOR, useValue: accessor }] : [])],
  }).compile();
  await moduleRef.init();
  return {
    service: moduleRef.get(WorkflowService),
    close: () => moduleRef.close(),
  };
}

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('DurableModule — context carrier auto-feed', () => {
  it('auto-feeds {traceId,tenantId,userRef} from a bound CONTEXT_ACCESSOR', async () => {
    const store = new InMemoryStateStore();
    const dispatched: RemoteTask[] = [];
    const accessor = fakeAccessor({
      traceId: 'trace-1',
      tenantId: 't1',
      userRef: { type: 'User', id: 7 },
    });
    const { service, close } = await buildModule(
      { store, transport: recordingTransport(dispatched) },
      accessor,
    );

    await service.start('wf', {}, 'r1');
    await settle(store, 'r1');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.context).toEqual({
      traceId: 'trace-1',
      tenantId: 't1',
      userRef: { type: 'User', id: 7 },
    });
    await close();
  });

  it('drops undefined accessor fields from the carrier', async () => {
    const store = new InMemoryStateStore();
    const dispatched: RemoteTask[] = [];
    // Only tenantId populated (anonymous, untraced request).
    const accessor = fakeAccessor({ tenantId: 't9' });
    const { service, close } = await buildModule(
      { store, transport: recordingTransport(dispatched) },
      accessor,
    );

    await service.start('wf', {}, 'r2');
    await settle(store, 'r2');

    expect(dispatched[0]?.context).toEqual({ tenantId: 't9' });
    await close();
  });

  it('app-provided `context` option overrides the accessor', async () => {
    const store = new InMemoryStateStore();
    const dispatched: RemoteTask[] = [];
    const accessor = fakeAccessor({ tenantId: 'from-accessor' });
    const { service, close } = await buildModule(
      {
        store,
        transport: recordingTransport(dispatched),
        context: () => ({ tenantId: 'from-app' }),
      },
      accessor,
    );

    await service.start('wf', {}, 'r3');
    await settle(store, 'r3');

    expect(dispatched[0]?.context).toEqual({ tenantId: 'from-app' });
    await close();
  });

  it('omits context when no accessor is bound (unchanged behavior; traceparent still works)', async () => {
    const store = new InMemoryStateStore();
    const dispatched: RemoteTask[] = [];
    const { service, close } = await buildModule({
      store,
      transport: recordingTransport(dispatched),
      traceparent: () => '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });

    await service.start('wf', {}, 'r4');
    await settle(store, 'r4');

    expect(dispatched[0]?.context).toBeUndefined();
    expect(dispatched[0]?.traceparent).toBe(
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
    await close();
  });
});
