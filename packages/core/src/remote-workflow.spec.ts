import { WorkflowEngine } from './engine';
import type { HistoryEvent, WorkflowDecision, WorkflowExecutor, WorkflowRun } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

/** A hand-scripted stand-in for the Python `WorkflowWorker.process_task` — it produces the same
 *  decisions the replay of this pipeline would, from the history the engine feeds it:
 *    ctx.step("setup")  ·  ctx.call("ingestion")  ·  ctx.sleep  ·  return { rows }
 *  (the Python replay runtime itself is unit-tested separately; here we exercise the ENGINE's drive
 *  + apply of the protocol.) */
function pipelineExecutor(opts: { withSleep?: boolean } = {}): WorkflowExecutor {
  return {
    async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
      const bySeq = new Map(history.map((e) => [e.seq, e]));
      const base = { taskId: 'task', runId: run.id } as const;
      const setupKey = `/${run.input}/data.csv`;
      const commands = [];
      if (!bySeq.has(0)) {
        commands.push({ kind: 'recordStep' as const, seq: 0, name: 'setup', output: setupKey });
      }
      if (!bySeq.has(1)) {
        commands.push({
          kind: 'call' as const,
          seq: 1,
          name: 'ingestion',
          group: 'pipeline',
          input: { key: bySeq.get(0)?.output ?? setupKey },
        });
        return { ...base, status: 'continue', commands };
      }
      const rows = bySeq.get(1)?.output;
      if (opts.withSleep && !bySeq.has(2)) {
        return { ...base, status: 'continue', commands: [{ kind: 'sleep', seq: 2, ms: 5 }] };
      }
      return { ...base, status: 'completed', commands: [], output: { rows, key: setupKey } };
    },
  };
}

describe('WorkflowEngine — remote (polyglot) workflows', () => {
  it('drives a remote workflow end-to-end: local step + remote call → completed', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('ingestion', async (input: { key: string }) => ({ ingested: input.key }));

    const engine = new WorkflowEngine({ store, transport });
    engine.registerRemote('pipeline', '1', { group: 'py-workflows', executor: pipelineExecutor() });

    const started = await startRun(engine, 'pipeline', 'b1', 'run1');
    expect(started.status).toBe('suspended'); // blocked on the dispatched remote call

    const run = await settle(store, 'run1');
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ rows: { ingested: '/b1/data.csv' }, key: '/b1/data.csv' });

    const cps = await store.listCheckpoints('run1');
    const setup = cps.find((c) => c.seq === 0);
    const call = cps.find((c) => c.seq === 1);
    expect(setup?.kind).toBe('local');
    expect(setup?.status).toBe('completed');
    expect(setup?.output).toBe('/b1/data.csv');
    expect(call?.kind).toBe('remote');
    expect(call?.status).toBe('completed');
    expect(call?.workerGroup).toBe('pipeline');
  });

  it('suspends a remote workflow on ctx.sleep and resumes it when the timer fires', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('ingestion', async () => ({ ingested: true }));

    let now = 1_000_000;
    const engine = new WorkflowEngine({ store, transport, clock: () => now });
    engine.registerRemote('pipeline', '1', {
      group: 'py-workflows',
      executor: pipelineExecutor({ withSleep: true }),
    });

    await startRun(engine, 'pipeline', 'b1', 'run2');
    // drive the remote call result; the workflow then hits the sleep and parks on a timer.
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setImmediate(r));
      const run = await store.getRun('run2');
      const sleepCp = (await store.listCheckpoints('run2')).find((c) => c.kind === 'sleep');
      if (run?.status === 'suspended' && sleepCp) break;
    }
    const suspended = await store.getRun('run2');
    expect(suspended?.status).toBe('suspended');
    expect(suspended?.wakeAt).toBe(now + 5); // ctx.sleep(5) → engine-computed deadline

    // advance the clock past the deadline (and the suspend lease) and fire the due timer → the run
    // resumes, replays past the now-elapsed timer in history, and completes.
    now += 1_000_000;
    await engine.resumeDueTimers(now);
    const done = await settle(store, 'run2');
    expect(done.status).toBe('completed');
  });

  it('fails the run when a remote workflow turn returns failed', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    engine.registerRemote('boom', '1', {
      group: 'py-workflows',
      executor: {
        async advance(run) {
          return {
            taskId: 't',
            runId: run.id,
            status: 'failed',
            commands: [],
            error: { message: 'workflow blew up' },
          };
        },
      },
    });

    await startRun(engine, 'boom', {}, 'run3');
    const run = await settle(store, 'run3');
    expect(run.status).toBe('failed');
    expect(run.error?.message).toBe('workflow blew up');
  });
});
