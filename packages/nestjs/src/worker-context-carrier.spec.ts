import type { DurableWorkerRuntime } from '@dudousxd/durable-worker';
import { Context, ContextModule, type ContextStore } from '@dudousxd/nestjs-context';
import {
  type Heartbeat,
  InMemoryStateStore,
  type RemoteTask,
  type StepResult,
  type Transport,
  type WorkflowCtx,
  type WorkflowDecision,
  WorkflowEngine,
  type WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Step, Workflow } from './decorators';
import { DURABLE_WORKER_RUNTIME, RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';
import { IN_APP_RUN_REDIS_WORKER, IN_APP_WORKER_RUNTIME } from './in-app-worker';

// A worker runtime restores the context carrier a dispatched turn or step carries, through the same
// nestjs-context `deserialize` bridge the engine uses around a local step. The app's deserializer
// decides what comes back. Configured like an app that keeps request authority out of durable work,
// it restores the trace id alone, so a handler never sees the user or tenant the request had, even
// though durable's default carrier sends them.

/** nestjs-context configured to restore correlation only, never authority. */
const contextModule = ContextModule.forRoot({
  autoMiddleware: false,
  carrier: ['traceId'],
  deserialize: (carrier) => ({ traceId: carrier.traceId }),
});

afterAll(() => Context.resetConfig());

type Store = Partial<ContextStore>;
const request: ContextStore = {
  traceId: 'a'.repeat(32),
  tenantId: 'company-1',
  userRef: { type: 'user', id: 'u-1' },
};

/** What each unit of work saw as its ambient context (a copy, or `null` when none was set). */
const seen: { turn: Array<Store | null>; step: Array<Store | null> } = { turn: [], step: [] };
const snapshot = (): Store | null => {
  const store = Context.get();
  return store ? { ...store } : null;
};

@Injectable()
class Probe {
  @Step('probe.run')
  async run(_input: unknown) {
    seen.step.push(snapshot());
    return 'probed';
  }
}

@Workflow({ name: 'ask.run', version: '1' })
class AskWorkflow {
  constructor(private readonly probe: Probe) {}

  async run(ctx: WorkflowCtx) {
    seen.turn.push(snapshot());
    return ctx.step(this.probe.run, {});
  }
}

afterEach(() => {
  seen.turn = [];
  seen.step = [];
});

describe('worker runtime restores the dispatched context carrier (thin worker)', () => {
  it('runs a dispatched turn and a dispatched step inside the trace their task carries, without authority', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [contextModule, DurableModule.forRoot({ connection: 'redis://x' })],
      providers: [AskWorkflow, Probe],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(async () => ({ close: async () => {} }))
      .compile();
    await moduleRef.init();
    const runtime = moduleRef.get<DurableWorkerRuntime>(DURABLE_WORKER_RUNTIME);

    // The carrier an engine with nestjs-context's auto-feed stamps: trace, tenant and user.
    const carrier = { ...request };
    const turn: WorkflowTask = {
      taskId: 'r1:wf:1',
      runId: 'r1',
      workflow: 'ask.run',
      workflowVersion: '1',
      input: {},
      history: [],
      group: 'ask.run',
      attempt: 1,
      context: carrier,
    };
    const out = await runtime.handleTask(turn);
    expect(out.kind).toBe('decision');
    expect(seen.turn).toEqual([{ traceId: request.traceId }]);
    // The decision echoes the carrier, so the engine dispatches this turn's step inside it.
    if (out.kind === 'decision') expect(out.decision.context).toEqual(carrier);

    const step: RemoteTask = {
      runId: 'r1',
      seq: 0,
      name: 'probe.run',
      stepId: 'r1:0',
      group: 'probe.run',
      input: {},
      attempt: 1,
      context: carrier,
    };
    const result = await runtime.handleTask(step);
    expect(result.kind === 'result' && result.result.status).toBe('completed');
    expect(seen.step).toEqual([{ traceId: request.traceId }]);
    expect(Context.get()).toBeUndefined();
    await moduleRef.close();
  });
});

/**
 * Carries the engine's tasks to the test instead of a broker: the test hands each one to the worker
 * runtime, as the BullMQ consumer would, and delivers the decision or result back.
 */
class Loopback implements Transport {
  readonly tasks: Array<WorkflowTask | RemoteTask> = [];
  decide?: (decision: WorkflowDecision) => Promise<void>;
  settle?: (result: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.tasks.push(task);
  }
  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.settle = handler;
  }
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.tasks.push(task);
  }
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decide = handler;
  }
}

describe('worker runtime restores the dispatched context carrier (co-located worker)', () => {
  it('carries the trace a run started with to its dispatched turn and the step that turn dispatches', async () => {
    const store = new InMemoryStateStore();
    const transport = new Loopback();
    const moduleRef = await Test.createTestingModule({
      imports: [
        contextModule,
        DurableModule.forRoot({
          store,
          transport,
          autoSchema: false,
          connection: 'redis://x',
          timerPollMs: 0,
          // No background driver: `runOne` inside the request is the only thing that runs the turn,
          // so no second, untraced dispatch of it can race the one under test.
          drive: false,
        }),
      ],
      providers: [AskWorkflow, Probe],
    })
      .overrideProvider(IN_APP_RUN_REDIS_WORKER)
      .useValue(async () => ({ close: async () => {} }))
      .compile();
    await moduleRef.init();
    const engine = moduleRef.get(WorkflowEngine);
    const runtime = moduleRef.get<DurableWorkerRuntime>(IN_APP_WORKER_RUNTIME);

    await Context.run({ ...request }, async () => {
      await engine.start('ask.run', {}, 'r1');
      await engine.runOne('r1');
    });

    // The worker consumes outside the request, as a BullMQ processor does.
    expect(Context.get()).toBeUndefined();
    for (let i = 0; i < 20 && (await store.getRun('r1'))?.status !== 'completed'; i += 1) {
      const task = transport.tasks.shift();
      if (!task) {
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      const out = await runtime.handleTask(task);
      if (out.kind === 'decision') await transport.decide?.(out.decision);
      else await transport.settle?.(out.result);
    }

    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(seen.turn.length).toBeGreaterThan(0);
    // The first turn was dispatched inside the request; it sees the request's trace and nothing else.
    // (The turn after the step result is dispatched where that result is applied, outside any
    // request, so it gets whatever the context reader yields there.)
    expect(seen.turn[0]).toEqual({ traceId: request.traceId });
    // The step that turn dispatched carries the same trace, still without the request's authority.
    expect(seen.step).toEqual([{ traceId: request.traceId }]);
    await moduleRef.close();
  });
});
