import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import {
  InMemoryStateStore,
  RemoteWorkflowExecutor,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { WorkflowWorker } from './workflow-worker';

// A dispatched turn that went quiet past the silence window is dispatched again, while the first
// copy keeps replaying on its worker. Its streamed step events name its turn, and the engine drops
// them once the run awaits another turn, so they never write over the live turn's checkpoints.

const SILENCE_MS = 30_000;

/** Workflow turns to an in-app worker, which streams its local steps back as step events. */
class LoopbackTransport implements Transport {
  private decisionHandler: ((decision: WorkflowDecision) => Promise<void>) | undefined;
  private stepEventHandler: ((event: WorkflowStepEvent) => Promise<void>) | undefined;
  private engine: WorkflowEngine | undefined;
  readonly events: WorkflowStepEvent[] = [];
  readonly turns: Promise<void>[] = [];

  constructor(
    private readonly worker: WorkflowWorker,
    private readonly stripTaskIds = false,
  ) {}

  attach(engine: WorkflowEngine): void {
    this.engine = engine;
  }

  async dispatch(_task: RemoteTask): Promise<void> {
    throw new Error('no remote steps here');
  }
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  onStepEvent(handler: (event: WorkflowStepEvent) => Promise<void>): void {
    this.stepEventHandler = handler;
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    if (!this.worker.handles(task.workflow)) {
      const body = this.engine?.workflowBody(task.workflow, task.workflowVersion);
      if (body) this.worker.register(task.workflow, body);
    }
    // Not awaited: a turn runs on its worker while the engine moves on, as over a broker.
    this.turns.push(
      (async () => {
        const decision = await this.worker.processTask(task, {
          onStep: (event) => {
            const sent = this.stripTaskIds ? { ...event, taskId: undefined } : event;
            this.events.push(sent);
            void this.stepEventHandler?.(sent);
          },
        });
        await this.decisionHandler?.(decision);
      })(),
    );
  }
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = handler;
  }
}

async function ticks(n = 50): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

function app(stripTaskIds: boolean) {
  let now = 10_000_000;
  const store = new InMemoryStateStore();
  const transport = new LoopbackTransport(new WorkflowWorker('app'), stripTaskIds);
  const engine = new WorkflowEngine({
    store,
    transport,
    clock: () => now,
    remoteAdvanceSilenceMs: SILENCE_MS,
  });
  transport.attach(engine);
  // Past the engine's boot window, so the lapsed turn below is not graced.
  now += SILENCE_MS + 1;
  let entries = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  engine.register(
    'wf',
    '1',
    async (ctx) =>
      ctx.localStep('pick', async () => {
        entries += 1;
        if (entries === 1) {
          await gate;
          return 'stale';
        }
        return 'live';
      }),
    { group: 'app', executor: new RemoteWorkflowExecutor(transport, 'app') },
  );
  return {
    store,
    transport,
    engine,
    release,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

describe('a dispatched turn that went quiet and was dispatched again', () => {
  it("keeps streaming on its first worker, but its step events never write over the live turn's", async () => {
    const a = app(false);
    await a.engine.start('wf', {}, 'r1');
    await ticks();
    const first = (await a.store.getRun('r1'))?.awaitingDecisionTaskId as string;
    expect((await a.store.getCheckpoint('r1', 0))?.status).toBe('running');

    // The first turn goes quiet past the window: counted lost, and dispatched again.
    await a.engine.resumeDueTimers(a.advance(SILENCE_MS + 1));
    await ticks();
    let run = await a.store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('live');

    // The first copy finishes now and streams its step: dropped, as is its decision.
    a.release();
    await Promise.all(a.transport.turns);
    await ticks();
    const stale = a.transport.events.filter((e) => e.taskId === first);
    expect(stale.map((e) => e.phase)).toEqual(['running', 'completed']);
    const cp = await a.store.getCheckpoint('r1', 0);
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toBe('live');
    run = await a.store.getRun('r1');
    expect(run?.output).toBe('live');
  });

  it('every event names the turn that streamed it', async () => {
    const a = app(false);
    await a.engine.start('wf', {}, 'r2');
    await ticks();
    await a.engine.resumeDueTimers(a.advance(SILENCE_MS + 1));
    await ticks();
    a.release();
    await Promise.all(a.transport.turns);
    const ids = new Set(a.transport.events.map((e) => e.taskId));
    expect(ids.size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^r2:wf:[0-9a-f]{8}$/);
  });

  it('from a worker that sends no task ids, the events are written as before', async () => {
    const a = app(true);
    await a.engine.start('wf', {}, 'r3');
    await ticks();
    expect((await a.store.getCheckpoint('r3', 0))?.status).toBe('running');
    await a.engine.resumeDueTimers(a.advance(SILENCE_MS + 1));
    await ticks();
    expect((await a.store.getRun('r3'))?.status).toBe('completed');
    a.release();
    await Promise.all(a.transport.turns);
    await ticks();
    // Unchecked: the stale copy's completion lands on the checkpoint, as it did before the field.
    expect((await a.store.getCheckpoint('r3', 0))?.output).toBe('stale');
  });
});
