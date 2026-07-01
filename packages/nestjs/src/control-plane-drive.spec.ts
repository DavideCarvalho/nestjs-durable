import {
  type Heartbeat,
  InMemoryStateStore,
  type StepResult,
  type Transport,
  type WorkflowDecision,
  WorkflowEngine,
  type WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { DurableControlPlaneModule, DurableModule } from './durable.module';

/** Reports a live 'processing' group and completes any dispatched workflow task immediately — the
 *  same fixture `remote-by-convention-module.spec.ts` uses, duplicated here so this file stands alone. */
class ConventionTransport implements Transport {
  readonly dispatchedGroups: string[] = [];
  private decisionHandler?: (decision: WorkflowDecision) => Promise<void>;

  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async listWorkerGroups(): Promise<string[]> {
    return ['processing'];
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.dispatchedGroups.push(task.group);
    setImmediate(
      () =>
        void this.decisionHandler?.({
          taskId: task.taskId,
          runId: task.runId,
          status: 'completed',
          commands: [],
          output: { fromConvention: true },
        }),
    );
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = handler;
  }
}

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

async function tick(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('DurableControlPlaneModule — drives while worker:false', () => {
  it('TimerPoller picks up a raw pending run on boot (worker:false, drive:true) and routes it remotely', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport();
    const now = new Date();
    // A run enqueued elsewhere (e.g. a tenant worker's DB-less `startRun`) that never went through
    // this instance's own `engine.start()` — only a poll loop would ever pick it up.
    await store.createRun({
      id: 'raw-pending-1',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'pending',
      input: { hello: 'world' },
      createdAt: now,
      updatedAt: now,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [DurableControlPlaneModule.forRoot({ store, transport, remoteByConvention: true })],
    }).compile();
    await moduleRef.init();

    const run = await settle(store, 'raw-pending-1');
    expect(run?.status).toBe('completed');
    expect(transport.dispatchedGroups).toEqual(['processing']);

    await moduleRef.close();
  });

  it('WorkflowRegistrar recovers a crashed (running) run on boot (worker:false, drive:true) and routes it remotely', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport();
    const now = new Date();
    await store.createRun({
      id: 'crashed-1',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'running',
      input: { hello: 'world' },
      createdAt: now,
      updatedAt: now,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [DurableControlPlaneModule.forRoot({ store, transport, remoteByConvention: true })],
    }).compile();
    await moduleRef.init();

    const run = await settle(store, 'crashed-1');
    expect(run?.status).toBe('completed');
    expect(transport.dispatchedGroups).toEqual(['processing']);

    await moduleRef.close();
  });

  it('wires the engine default run dispatcher (NOT the no-op) — a freshly start()ed run dispatches immediately', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport();

    const moduleRef = await Test.createTestingModule({
      imports: [DurableControlPlaneModule.forRoot({ store, transport, remoteByConvention: true })],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    await engine.start('processing', { hello: 'world' }, 'fresh-1');
    const run = await settle(store, 'fresh-1');

    expect(run?.status).toBe('completed');
    expect(transport.dispatchedGroups).toEqual(['processing']);

    await moduleRef.close();
  });

  it('regression: a plain DurableModule.forRoot({ worker: false }) API pod STILL has drive off — no-op dispatch, no boot poll', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport();
    const now = new Date();
    await store.createRun({
      id: 'raw-pending-2',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      createdAt: now,
      updatedAt: now,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store, transport, remoteByConvention: true, worker: false }),
      ],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    await engine.start('processing', {}, 'fresh-2');
    await tick();

    // Neither the pre-existing pending run nor the freshly started one moved — no boot poll ran,
    // and the no-op dispatcher left the fresh one enqueue-only.
    expect((await store.getRun('raw-pending-2'))?.status).toBe('pending');
    expect((await store.getRun('fresh-2'))?.status).toBe('pending');
    expect(transport.dispatchedGroups).toEqual([]);

    await moduleRef.close();
  });

  it('regression: DurableModule.forRoot({}) (worker:true default) is unchanged — drives + dispatches immediately', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport();

    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport, remoteByConvention: true })],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    await engine.start('processing', { hello: 'world' }, 'fresh-3');
    const run = await settle(store, 'fresh-3');

    expect(run?.status).toBe('completed');
    expect(transport.dispatchedGroups).toEqual(['processing']);

    await moduleRef.close();
  });
});
