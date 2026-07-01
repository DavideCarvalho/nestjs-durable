import {
  DurableWorkerRuntime,
  type RunRedisWorkerOptions,
  type RunningWorker,
} from '@dudousxd/durable-worker';
import type { RemoteStepDef, WorkflowCtx, WorkflowTask } from '@dudousxd/nestjs-durable-core';
import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { Step, Workflow } from './decorators';
import {
  DURABLE_WORKER_RUNNERS,
  DurableWorkerModule,
  RUN_REDIS_WORKER,
} from './durable-worker.module';

const charge: RemoteStepDef<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
  __remote: true,
};

@Workflow({ name: 'checkout', version: '1' })
class CheckoutWorkflow {
  async run(ctx: WorkflowCtx, order: { amount: number }) {
    const doubled = await ctx.step('double', () => order.amount * 2);
    const c = await ctx.call(charge, { amount: doubled });
    return { doubled, chargeId: c.chargeId };
  }
}

@Injectable()
class PaymentsWorker {
  @Step('payments.charge')
  async charge(input: { amount: number }) {
    return { chargeId: `ch_${input.amount}` };
  }
}

@Workflow({ name: 'w', version: '1' })
class WWorkflow {
  async run(_ctx: WorkflowCtx, input: unknown) {
    return input;
  }
}

/** A captured `runRedisWorker` call + the fake handle it returned, so the spec can assert start/close. */
interface FakeRunner {
  calls: RunRedisWorkerOptions[];
  handles: Array<{ closed: boolean }>;
  runRedisWorker: (opts: RunRedisWorkerOptions) => Promise<RunningWorker>;
}

function fakeRunner(): FakeRunner {
  const calls: RunRedisWorkerOptions[] = [];
  const handles: Array<{ closed: boolean }> = [];
  return {
    calls,
    handles,
    runRedisWorker: async (opts) => {
      calls.push(opts);
      const handle = { closed: false };
      handles.push(handle);
      return {
        async close() {
          handle.closed = true;
        },
      };
    },
  };
}

describe('DurableWorkerModule', () => {
  it('registers @Workflow + @Step on a store-less DurableWorkerRuntime', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableWorkerModule.forRoot({ connection: 'redis://x', groups: ['payments'] })],
      providers: [CheckoutWorkflow, PaymentsWorker],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    await moduleRef.init();

    const runtime = moduleRef.get(DurableWorkerRuntime);
    expect(runtime.workflows.handles('checkout')).toBe(true);
    expect(runtime.steps).toBeDefined();

    // Drive the workflow task: first turn records the local step + emits the remote call, suspends.
    const task: WorkflowTask = {
      taskId: 't1',
      runId: 'run1',
      workflow: 'checkout',
      workflowVersion: '1',
      input: { amount: 21 },
      history: [],
      group: 'payments',
      attempt: 1,
    };
    const out = await runtime.handleTask(task);
    expect(out.kind).toBe('decision');
    if (out.kind === 'decision') {
      const cmds = out.decision.commands;
      expect(cmds[0]).toMatchObject({ kind: 'recordStep', seq: 0, name: 'double', output: 42 });
      expect(cmds[1]).toMatchObject({
        kind: 'call',
        seq: 1,
        name: 'payments.charge',
        input: { amount: 42 },
      });
      expect(out.decision.status).toBe('continue');
    }

    // Drive the remote step task → it runs the @Step handler and returns a result.
    const stepOut = await runtime.handleTask({
      runId: 'run1',
      seq: 1,
      name: 'payments.charge',
      stepId: 's1',
      group: 'payments',
      input: { amount: 42 },
      attempt: 1,
    });
    expect(stepOut.kind).toBe('result');
    if (stepOut.kind === 'result') {
      expect(stepOut.result.status).toBe('completed');
      expect(stepOut.result.output).toEqual({ chargeId: 'ch_42' });
    }

    await moduleRef.close();
  });

  it('does NOT create an engine / store / dashboard provider (control-plane-less)', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableWorkerModule.forRoot({ connection: 'redis://x', groups: ['g'] })],
      providers: [CheckoutWorkflow],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    await moduleRef.init();

    // The whole point: no WorkflowEngine is bound. `get` (non-strict) must not resolve one.
    expect(() => moduleRef.get(WorkflowEngine, { strict: false })).toThrow();

    await moduleRef.close();
  });

  it('starts one runner per group on bootstrap and closes them on shutdown', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableWorkerModule.forRoot({
          connection: 'redis://x',
          groups: ['payments', 'emails'],
          prefix: 'app',
          instanceId: 'w1',
        }),
      ],
      providers: [CheckoutWorkflow, PaymentsWorker],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    moduleRef.enableShutdownHooks();
    await moduleRef.init();

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.map((c) => c.group).sort()).toEqual(['emails', 'payments']);
    for (const c of runner.calls) {
      expect(c.connection).toBe('redis://x');
      expect(c.prefix).toBe('app');
      expect(c.instanceId).toBe('w1');
      expect(c.runtime).toBe(moduleRef.get(DurableWorkerRuntime));
    }

    await moduleRef.close();
    expect(runner.handles.every((h) => h.closed)).toBe(true);
  });

  it('forRootAsync wires the same options via a factory', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableWorkerModule.forRootAsync({
          useFactory: () => ({ connection: 'redis://y', groups: ['g'] }),
        }),
      ],
      providers: [CheckoutWorkflow],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    await moduleRef.init();

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.connection).toBe('redis://y');
    const runners = moduleRef.get<RunningWorker[]>(DURABLE_WORKER_RUNNERS);
    expect(runners).toHaveLength(1);

    await moduleRef.close();
  });

  it('with a tenant, serves a discovered workflow under its tenant-suffixed group (w@t1)', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableWorkerModule.forRoot({ connection: 'redis://x', groups: ['w'], tenant: 't1' }),
      ],
      providers: [WWorkflow],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    await moduleRef.init();

    const runtime = moduleRef.get(DurableWorkerRuntime);
    expect(runtime.workflows.handles('w')).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.group).toBe('w@t1');

    await moduleRef.close();
  });

  it('with no tenant, serves the discovered workflow under the bare group (w)', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableWorkerModule.forRoot({ connection: 'redis://x', groups: ['w'] })],
      providers: [WWorkflow],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    await moduleRef.init();

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.group).toBe('w');

    await moduleRef.close();
  });
});
