import { AsyncLocalStorage } from 'node:async_hooks';
import { InMemoryStateStore, type WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextAccessor, UserRef } from './context-accessor';
import { Workflow } from './decorators';
import { DurableModule, type DurableModuleOptions } from './durable.module';
import { CONTEXT_ACCESSOR } from './tokens';
import { WorkflowService } from './workflow.service';

/**
 * A real ALS-backed stand-in for `@dudousxd/nestjs-context`'s module-level `Context` singleton. The
 * module resolves the runtime via a guarded dynamic `import('@dudousxd/nestjs-context')`, which this
 * mock intercepts — so we exercise the genuine "run the step body inside an ambient context carrying
 * the carrier" path without depending on the (separate-repo) real package being installed.
 */
const als = new AsyncLocalStorage<Record<string, unknown>>();
const Context = {
  deserialize<T>(carrier: Record<string, unknown>, fn: () => T): T {
    return als.run({ ...carrier }, fn);
  },
  traceId: () => als.getStore()?.traceId as string | undefined,
  tenantId: () => als.getStore()?.tenantId as string | undefined,
  userRef: () => als.getStore()?.userRef as UserRef | undefined,
};
vi.mock('@dudousxd/nestjs-context', () => ({ Context }));

/** What a local step body observed via the (mocked) ambient context. */
let observed: { traceId?: string; tenantId?: string; userRef?: UserRef } | undefined;

@Workflow({ name: 'wf', version: '1' })
class Wf {
  async run(ctx: WorkflowCtx) {
    return ctx.step('peek', async () => {
      observed = {
        traceId: Context.traceId(),
        tenantId: Context.tenantId(),
        userRef: Context.userRef(),
      };
      return 'ok';
    });
  }
}

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
  return { service: moduleRef.get(WorkflowService), close: () => moduleRef.close() };
}

describe('DurableModule — local step context re-hydration (consume side)', () => {
  beforeEach(() => {
    observed = undefined;
  });

  it('runs a local step body inside an ambient context carrying the accessor carrier', async () => {
    const store = new InMemoryStateStore();
    const accessor = fakeAccessor({
      traceId: 'trace-1',
      tenantId: 't1',
      userRef: { type: 'User', id: 7 },
    });
    const { service, close } = await buildModule({ store }, accessor);

    await service.start('wf', {}, 'r1');
    await service.waitForRun('r1', { timeoutMs: 2000 });

    expect(observed).toEqual({
      traceId: 'trace-1',
      tenantId: 't1',
      userRef: { type: 'User', id: 7 },
    });
    await close();
  });

  it('runs the step normally (empty ambient context) when no accessor is bound', async () => {
    const store = new InMemoryStateStore();
    // No CONTEXT_ACCESSOR provider → rehydrate stays default passthrough; the step still runs.
    const { service, close } = await buildModule({ store });

    const start = await service.start('wf', {}, 'r2');
    expect(start.runId).toBe('r2');
    await service.waitForRun('r2', { timeoutMs: 2000 });

    expect(observed).toEqual({ traceId: undefined, tenantId: undefined, userRef: undefined });
    await close();
  });
});
