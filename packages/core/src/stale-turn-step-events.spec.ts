import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkflowStepEvent } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

// A dispatched turn that went quiet past the silence window is dispatched again, while its first
// worker may still be replaying it and streaming its local steps. The engine keeps a streamed step
// event only while the run awaits the turn that sent it; an event that names no turn (a worker from
// before `WorkflowStepEvent.taskId`) is kept, as before.

const RUN = 'r1';
const LIVE = `${RUN}:wf:live0001`;
const STALE = `${RUN}:wf:stale001`;

async function setup(awaiting: string | undefined) {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  new WorkflowEngine({ store, transport });
  const now = new Date();
  await store.createRun({
    id: RUN,
    workflow: 'wf',
    workflowVersion: '1',
    status: 'suspended',
    input: {},
    createdAt: now,
    updatedAt: now,
    ...(awaiting !== undefined ? { awaitingDecisionTaskId: awaiting } : {}),
  });
  const send = (event: Omit<WorkflowStepEvent, 'runId' | 'name' | 'startedAt'>) =>
    transport.dispatchStepEvent({ runId: RUN, name: 'charge', startedAt: 1_000, ...event });
  const checkpoint = async () => store.getCheckpoint(RUN, 0);
  return { store, send, checkpoint };
}

describe('streamed step events of a dispatched turn', () => {
  it("are dropped when they come from a turn the run no longer awaits, and the live turn's are kept", async () => {
    const { send, checkpoint } = await setup(LIVE);

    await send({ taskId: STALE, seq: 0, phase: 'running' });
    await send({ taskId: STALE, seq: 0, phase: 'completed', output: 'stale', finishedAt: 1_100 });
    expect(await checkpoint()).toBeNull();

    await send({ taskId: LIVE, seq: 0, phase: 'completed', output: 'live', finishedAt: 1_200 });
    expect((await checkpoint())?.output).toBe('live');

    // A late event of the stale turn does not write over the live turn's checkpoint.
    await send({ taskId: STALE, seq: 0, phase: 'failed', error: { message: 'stale' } });
    await send({ taskId: STALE, seq: 0, phase: 'running' });
    const cp = await checkpoint();
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toBe('live');
  });

  it('are kept for a turn counted lost or graced but not dispatched again yet', async () => {
    for (const marker of [`${LIVE}:lost`, `${LIVE}:grace`, `${LIVE}:grace:lost`]) {
      const { send, checkpoint } = await setup(marker);
      await send({ taskId: LIVE, seq: 0, phase: 'completed', output: marker, finishedAt: 1_100 });
      expect((await checkpoint())?.output).toBe(marker);
    }
  });

  it('are dropped once the run awaits no turn, or is gone', async () => {
    const { send, checkpoint } = await setup(undefined);
    await send({ taskId: LIVE, seq: 0, phase: 'running' });
    expect(await checkpoint()).toBeNull();

    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    new WorkflowEngine({ store, transport });
    await transport.dispatchStepEvent({
      runId: 'missing',
      taskId: LIVE,
      seq: 0,
      name: 'charge',
      phase: 'running',
      startedAt: 1_000,
    });
    expect(await store.getCheckpoint('missing', 0)).toBeNull();
  });

  it('without a task id (a worker from before the field) are kept as before', async () => {
    const { send, checkpoint } = await setup(LIVE);
    await send({ seq: 0, phase: 'running' });
    expect((await checkpoint())?.status).toBe('running');
    await send({ seq: 0, phase: 'completed', output: 'old worker', finishedAt: 1_100 });
    expect((await checkpoint())?.output).toBe('old worker');

    // Also when the run awaits no turn: an old worker's events are not checked at all.
    const other = await setup(undefined);
    await other.send({ seq: 0, phase: 'completed', output: 'unchecked', finishedAt: 1_100 });
    expect((await other.checkpoint())?.output).toBe('unchecked');
  });
});
