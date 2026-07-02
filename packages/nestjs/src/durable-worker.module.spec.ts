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
import { DurableStartClient } from './durable-start-client';
import { DURABLE_WORKER_RUNNERS, RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

const charge: RemoteStepDef<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
  __remote: true,
};

@Workflow({ name: 'checkout', version: '1' })
class CheckoutWorkflow {
  async run(ctx: WorkflowCtx, order: { amount: number }) {
    const doubled = await ctx.step('double', () => order.amount * 2);
    const c = await ctx.remote(charge, { amount: doubled });
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

/** Minimal fixture for the handler-derivation tests: a `checkout` workflow + a bare `charge` step. */
@Workflow({ name: 'checkout', version: '1' })
class MinimalCheckoutWorkflow {
  async run(_ctx: WorkflowCtx, input: unknown) {
    return input;
  }
}

@Injectable()
class ChargeWorker {
  @Step('charge')
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

describe('DurableModule.forRoot({ connection }) — pure thin worker', () => {
  it('registers @Workflow + @Step on a store-less DurableWorkerRuntime', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ connection: 'redis://x' })],
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
      group: 'checkout',
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
      group: 'payments.charge',
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

  it('does NOT create a store / dashboard provider (control-plane-less)', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ connection: 'redis://x' })],
      providers: [CheckoutWorkflow],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    await moduleRef.init();

    // The role IS control-plane-less: the WorkflowEngine token resolves to the store-less
    // DurableStartClient facade (see the dedicated test below), never a full store-backed engine.
    expect(moduleRef.get(WorkflowEngine, { strict: false })).toBeInstanceOf(DurableStartClient);

    await moduleRef.close();
  });

  it('provides a store-less start facade under the WorkflowEngine token', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          connection: 'redis://x',
          partition: 'davi-local',
        }),
      ],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(async () => ({ close: async () => {} }))
      .compile();

    const engine = moduleRef.get(WorkflowEngine);
    expect(engine).toBeInstanceOf(DurableStartClient);

    const service = moduleRef.get(WorkflowService);
    expect(service).toBeInstanceOf(WorkflowService);
  });

  it('starts exactly ONE runner (handler-derived subscription) with no `groups` configured', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          connection: 'redis://x',
          prefix: 'app',
          instanceId: 'w1',
        }),
      ],
      providers: [MinimalCheckoutWorkflow, ChargeWorker],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    moduleRef.enableShutdownHooks();
    await moduleRef.init();

    // Exactly one runRedisWorker call — not one per discovered handler, and no hand-declared group.
    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0];
    expect(call?.connection).toBe('redis://x');
    expect(call?.prefix).toBe('app');
    expect(call?.instanceId).toBe('w1');
    expect(call?.runtime).toBe(moduleRef.get(DurableWorkerRuntime));
    expect(call?.group).toBeUndefined();
    expect(call?.partition).toBeUndefined();

    // Both discovered handlers are registered on the runtime the single call carries — the runner
    // derives its per-name subscriptions from exactly this registry.
    const runtime = moduleRef.get(DurableWorkerRuntime);
    expect(runtime.workflows.handles('checkout')).toBe(true);
    expect(runtime.steps.handles('charge')).toBe(true);
    expect(runtime.registeredNames()).toEqual({ workflows: ['checkout'], steps: ['charge'] });

    await moduleRef.close();
    expect(runner.handles.every((h) => h.closed)).toBe(true);
  });

  it('forRootAsync wires the same options via a factory', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRootAsync({
          useFactory: () => ({ connection: 'redis://y' }),
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

  it('with a partition, the single runRedisWorker call carries it', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ connection: 'redis://x', partition: 'p1' })],
      providers: [WWorkflow],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    await moduleRef.init();

    const runtime = moduleRef.get(DurableWorkerRuntime);
    expect(runtime.workflows.handles('w')).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.partition).toBe('p1');

    await moduleRef.close();
  });

  it('with no partition, the single call carries none', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ connection: 'redis://x' })],
      providers: [WWorkflow],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    await moduleRef.init();

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.partition).toBeUndefined();

    await moduleRef.close();
  });
});
