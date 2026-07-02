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
import {
  InMemoryStateStore,
  WorkflowEngine,
  sanitizeQueueToken,
  tenantGroup,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Step, Workflow } from './decorators';
import { DurableModule } from './durable.module';
import {
  IN_APP_RUN_REDIS_WORKER,
  IN_APP_WORKER_RUNTIME,
  type RunRedisWorkerFn,
} from './in-app-worker';

// ---------------------------------------------------------------------------
// In-app worker (uniform dispatch, co-located role) — NestJS wiring.
//
// `DurableModule.forRoot({ store, transport, connection, partition? })` turns one app into engine +
// worker: every discovered `@Workflow` is registered GROUP-SERVED — its turns dispatched, PER
// WORKFLOW NAME, to `tenantGroup(sanitizeQueueToken(name), partition)` — and a co-located
// `DurableWorkerRuntime` subscribes one queue per discovered name (via `runRedisWorker`) to replay the
// SAME bodies. These specs assert the WIRING (registration + consumer start + PER-WORKFLOW routing
// token) with a fake `runRedisWorker` and a workflow-task transport double — no Redis. The full
// dispatch→replay loop is proven at the core/worker level (packages/worker/in-app-worker.spec) over
// the real executor + worker.
// ---------------------------------------------------------------------------

@Workflow({ name: 'greet', version: '1' })
class GreetWorkflow {
  async run(ctx: WorkflowCtx, name: string) {
    return ctx.step('compose', () => `hello ${name}`);
  }
}

@Injectable()
class Emails {
  @Step('emails.send')
  async send(input: { to: string }) {
    return { sent: input.to };
  }
}

@Workflow({ name: 'alpha', version: '1' })
class AlphaWorkflow {
  async run(ctx: WorkflowCtx, input: unknown) {
    return ctx.step('alpha.step', () => input);
  }
}

@Workflow({ name: 'beta', version: '1' })
class BetaWorkflow {
  async run(ctx: WorkflowCtx, input: unknown) {
    return ctx.step('beta.step', () => input);
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
  calls: Array<{ connection: unknown; prefix?: string; instanceId?: string; partition?: string }>;
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
        connection: opts.connection,
        ...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}),
        ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
        ...(opts.partition !== undefined ? { partition: opts.partition } : {}),
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

describe('DurableModule co-located worker (store + connection)', () => {
  it('registers @Workflow group-served (per-name token) and starts a co-located consumer', async () => {
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: new WorkflowTaskTransport(),
          autoSchema: false,
          partition: 'tenantA',
          connection: 'redis://x',
          prefix: 'durable',
          instanceId: 'w1',
        }),
      ],
      providers: [GreetWorkflow, Emails],
    })
      .overrideProvider(IN_APP_RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    moduleRef.enableShutdownHooks();
    await moduleRef.init();

    // ENGINE half: the workflow is group-served — the engine dispatches its turns to its OWN
    // name-derived token, and the retained TS body is reachable by name for the consumer.
    const engine = moduleRef.get(WorkflowEngine);
    expect(engine.knownGroups()).toEqual([tenantGroup(sanitizeQueueToken('greet'), 'tenantA')]);
    expect(engine.workflowBody('greet', '1')).toBeTypeOf('function');

    // CONSUMER half: the same body + step are registered on the co-located runtime, and one consumer
    // started with the configured partition/connection/prefix/instanceId (subscription itself is
    // derived from `runtime.registeredNames()` inside `runRedisWorker`, one queue per name).
    const runtime = moduleRef.get<DurableWorkerRuntime>(IN_APP_WORKER_RUNTIME);
    expect(runtime.workflows.handles('greet')).toBe(true);
    expect(runtime.steps.handles('emails.send')).toBe(true);
    // Bug guard: the runtime's workflow partition MUST equal this app's `partition` (NOT
    // `WorkflowWorker`'s `'workflows'` default) — else an implicit-partition `ctx.remote` emits a
    // `<step>@workflows` decision token that no co-located consumer subscribes to, and the step
    // dead-ends forever.
    expect(runtime.workflows.group).toBe('tenantA');
    expect(runner.calls).toEqual([
      { connection: 'redis://x', prefix: 'durable', instanceId: 'w1', partition: 'tenantA' },
    ]);

    await moduleRef.close();
    expect(runner.handles.every((h) => h.closed)).toBe(true);
  });

  it('keeps @Workflow inline and starts no consumer when connection is omitted (plain operator)', async () => {
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

  it('fails fast when co-located (store + connection) but the transport cannot carry workflow tasks', async () => {
    const runner = fakeRunner();
    await expect(
      Test.createTestingModule({
        imports: [
          DurableModule.forRoot({
            store: new InMemoryStateStore(),
            transport: new InProcessOnlyTransport(),
            autoSchema: false,
            connection: 'redis://x',
          }),
        ],
        providers: [GreetWorkflow],
      })
        .overrideProvider(IN_APP_RUN_REDIS_WORKER)
        .useValue(runner.runRedisWorker)
        .compile(),
    ).rejects.toThrow(/transport that carries workflow tasks/);
  });

  it('registers each @Workflow group-served under ITS OWN name-derived token, not one shared group', async () => {
    // The bug this locks in: a single static executor bound to every discovered `@Workflow` would
    // register alpha AND beta group-served under the SAME fixed token, while the co-located worker
    // (Task 5) subscribes one queue PER REGISTERED NAME — so a turn under the wrong token is never
    // consumed. The fix: a PER-WORKFLOW `RemoteWorkflowExecutor`, keyed by that workflow's own name,
    // so each registers under `tenantGroup(sanitizeQueueToken(name), partition)`. `knownGroups()`
    // surfaces exactly those registered group-served tokens (see the single-workflow test above).
    const runner = fakeRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: new WorkflowTaskTransport(),
          autoSchema: false,
          partition: 'tenantA',
          connection: 'redis://x',
        }),
      ],
      providers: [AlphaWorkflow, BetaWorkflow],
    })
      .overrideProvider(IN_APP_RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine);
    const alphaToken = tenantGroup(sanitizeQueueToken('alpha'), 'tenantA');
    const betaToken = tenantGroup(sanitizeQueueToken('beta'), 'tenantA');
    // Both workflows registered, EACH under its own name-derived token — not collapsed onto one.
    expect(engine.knownGroups().sort()).toEqual([alphaToken, betaToken].sort());
    expect(alphaToken).not.toBe(betaToken);

    await moduleRef.close();
  });
});
