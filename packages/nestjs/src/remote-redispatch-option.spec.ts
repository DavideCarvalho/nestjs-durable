import {
  type Heartbeat,
  InMemoryStateStore,
  type RemoteTask,
  type StepResult,
  type Transport,
  type WorkflowDecision,
  WorkflowEngine,
  type WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DurableModule } from './durable.module';

/**
 * A lost-dispatch self-heal nobody can turn on is no self-heal: `remoteRedispatchMs` /
 * `remoteRedispatchMax` were engine options the Nest module never forwarded, so every consumer that
 * wires the engine through `DurableModule` (which is all of them) was stuck with the orphan-forever
 * default regardless of what it passed.
 *
 * The observable proof that the option arrived is the LEASE: with it set, a dispatched remote step's
 * `pending` checkpoint carries a `wakeAt` deadline, and the run suspends on it. Without it, both are
 * NULL — which is exactly what the orphaned production rows looked like.
 */

const WINDOW_MS = 60_000;

/** A polyglot workflow worker that fans out one `call` — and a step queue that LOSES it (the
 *  OOM-killed worker: no result will ever come back). */
class LostCallTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  private decisionHandler?: (decision: WorkflowDecision) => Promise<void>;

  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async listWorkerGroups(): Promise<string[]> {
    return ['processing'];
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    setImmediate(
      () =>
        void this.decisionHandler?.({
          taskId: task.taskId,
          runId: task.runId,
          status: 'continue',
          commands: [
            { kind: 'call', seq: 0, name: 'handle_MVR', input: {}, parallelGroup: 'gather:0' },
          ],
        }),
    );
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = handler;
  }
}

/** Wait until the turn's `call` command has been applied — the run is `suspended` from the moment it
 *  awaits the decision (SUSPEND-then-ENQUEUE), so the checkpoint is what marks the dispatch. */
async function dispatchedStep(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((r) => setImmediate(r));
    const [cp] = await store.listCheckpoints(runId);
    const run = await store.getRun(runId);
    if (cp && run?.status === 'suspended' && run.awaitingDecisionTaskId === undefined) {
      return { cp, run };
    }
  }
  throw new Error(`run ${runId} never dispatched its step`);
}

async function bootstrap(store: InMemoryStateStore, transport: Transport, redispatchMs?: number) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store,
        transport,
        ...(redispatchMs === undefined ? {} : { remoteRedispatchMs: redispatchMs }),
      }),
    ],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('DurableModule — remoteRedispatchMs reaches the engine', () => {
  it('leases the dispatched step (checkpoint + run wakeAt) when the option is set', async () => {
    const store = new InMemoryStateStore();
    const transport = new LostCallTransport();
    const moduleRef = await bootstrap(store, transport, WINDOW_MS);
    const before = Date.now();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    await engine.start('processing', {}, 'lease-on');
    const { cp, run } = await dispatchedStep(store, 'lease-on');

    expect(transport.dispatched.map((t) => t.name)).toEqual(['handle_MVR']);
    expect(cp.status).toBe('pending');
    expect(cp.wakeAt).toBeGreaterThanOrEqual(before + WINDOW_MS);
    expect(cp.wakeAt).toBeLessThanOrEqual(Date.now() + WINDOW_MS);
    expect(run.wakeAt).toBe(cp.wakeAt);

    await moduleRef.close();
  });

  it('leaves the step unleased when the option is omitted (the shipped default)', async () => {
    const store = new InMemoryStateStore();
    const transport = new LostCallTransport();
    const moduleRef = await bootstrap(store, transport);

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    await engine.start('processing', {}, 'lease-off');
    const { cp } = await dispatchedStep(store, 'lease-off');

    expect(cp.status).toBe('pending');
    expect(cp.wakeAt).toBeUndefined();

    await moduleRef.close();
  });
});
