import { DurableWorkerRuntime } from '@dudousxd/durable-worker';
import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowCtx,
  WorkflowDecision,
  WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DurableStep, Workflow } from './decorators';
import { DurableModule } from './durable.module';
import {
  IN_APP_RUN_REDIS_WORKER,
  IN_APP_WORKER_RUNTIME,
  type RunRedisWorkerFn,
} from './in-app-worker';

// ---------------------------------------------------------------------------
// In-app worker (uniform dispatch, opt-in) — NestJS wiring.
//
// `DurableModule.forRoot({ ..., inAppWorker: { group, connection } })` turns one app into engine +
// worker: every discovered `@Workflow` is registered GROUP-SERVED (its turns dispatched to `group`)
// and a co-located `DurableWorkerRuntime` consumes `group` (via `runRedisWorker`) to replay the SAME
// bodies. These specs assert the WIRING (registration + consumer start) with a fake `runRedisWorker`
// and a workflow-task transport double — no Redis. The full dispatch→replay loop is proven at the
// core/worker level (packages/worker/in-app-worker.spec) over the real executor + worker.
// ---------------------------------------------------------------------------

@Workflow({ name: 'greet', version: '1' })
class GreetWorkflow {
  async run(ctx: WorkflowCtx, name: string) {
    return ctx.step('compose', () => `hello ${name}`);
  }
}

@Injectable()
class Emails {
  @DurableStep('emails.send')
  async send(input: { to: string }) {
    return { sent: input.to };
  }
}

/** A transport double that carries workflow tasks (the in-app worker needs `dispatchWorkflowTask` +
 *  `onDecision`, the surface `RemoteWorkflowExecutor` binds to). It records nothing — the wiring tests
 *  never dispatch (the store is empty, so recovery is a no-op). */
class WorkflowTaskTransport implements Transport {
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  async dispatchWorkflowTask(_task: WorkflowTask): Promise<void> {}
  onDecision(_handler: (decision: WorkflowDecision) => Promise<void>): void {}
}

/** An in-process-only transport (no workflow-task surface) — opting into an in-app worker with one of
 *  these must fail fast, since a group-served turn would dead-end at dispatch. */
class InProcessOnlyTransport implements Transport {
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
}

interface FakeRunner {
  calls: Array<{ group: string; connection: unknown; prefix?: string; instanceId?: string }>;
  handles: Array<{ closed: boolean }>;
  runRedisWorker: RunRedisWorkerFn;
}

function fakeRunner(): FakeRunner {
  const calls: FakeRunner['calls'] = [];
  const handles: Array<{ closed: boolean }> = [];
  return {
    calls,
    handles,
    runRedisWorker: async (opts) => {
      calls.push({
        group: opts.group,
        connection: opts.connection,
        prefix: opts.prefix,
        instanceId: opts.instanceId,
      });
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

describe('DurableModule inAppWorker (uniform dispatch, opt-in)', () => {
  it('registers @Workflow group-served and starts a co-located consumer on the group', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: new WorkflowTaskTransport(),
          autoSchema: false,
          inAppWorker: {
            group: 'app',
            connection: 'redis://x',
            prefix: 'durable',
            instanceId: 'w1',
          },
        }),
      ],
      providers: [GreetWorkflow, Emails],
    })
      .overrideProvider(IN_APP_RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    moduleRef.enableShutdownHooks();
    await moduleRef.init();

    // ENGINE half: the workflow is group-served — the engine dispatches its turns to `app`, and the
    // retained TS body is reachable by name for the consumer.
    const engine = moduleRef.get(WorkflowEngine);
    expect(engine.knownGroups()).toEqual(['app']);
    expect(engine.workflowBody('greet', '1')).toBeTypeOf('function');

    // CONSUMER half: the same body + step are registered on the co-located runtime, and one consumer
    // started on the group with the configured connection/prefix/instanceId.
    const runtime = moduleRef.get<DurableWorkerRuntime>(IN_APP_WORKER_RUNTIME);
    expect(runtime.workflows.handles('greet')).toBe(true);
    expect(runtime.steps.handles('emails.send')).toBe(true);
    expect(runner.calls).toEqual([
      { group: 'app', connection: 'redis://x', prefix: 'durable', instanceId: 'w1' },
    ]);

    await moduleRef.close();
    expect(runner.handles.every((h) => h.closed)).toBe(true);
  });

  it('keeps @Workflow inline and starts no consumer when inAppWorker is omitted (default)', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: new WorkflowTaskTransport(),
          autoSchema: false,
        }),
      ],
      providers: [GreetWorkflow],
    })
      .overrideProvider(IN_APP_RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine);
    // Inline default: no group routing, and the body still runs in-process (it's retained, just not served).
    expect(engine.knownGroups()).toEqual([]);
    expect(engine.workflowBody('greet', '1')).toBeTypeOf('function');
    // No consumer was started — the in-app worker is strictly opt-in.
    expect(runner.calls).toEqual([]);

    await moduleRef.close();
  });

  it('fails fast when inAppWorker is set but the transport cannot carry workflow tasks', async () => {
    const runner = fakeRunner();
    await expect(
      Test.createTestingModule({
        imports: [
          DurableModule.forRoot({
            store: new InMemoryStateStore(),
            transport: new InProcessOnlyTransport(),
            autoSchema: false,
            inAppWorker: { group: 'app', connection: 'redis://x' },
          }),
        ],
        providers: [GreetWorkflow],
      })
        .overrideProvider(IN_APP_RUN_REDIS_WORKER)
        .useValue(runner.runRedisWorker)
        .compile(),
    ).rejects.toThrow(/transport that carries workflow tasks/);
  });
});
