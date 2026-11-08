import {
  InMemoryStateStore,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowExecutor,
  type WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { WorkflowWorker } from './workflow-worker';

function task(over: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    taskId: 't0',
    runId: 'r1',
    workflow: 'wf',
    workflowVersion: '1',
    input: null,
    history: [],
    group: 'wf',
    attempt: 1,
    ...over,
  };
}

const race = async (ctx: WorkflowCtx) => {
  const first = await ctx.waitForAny('race', {
    go: ctx.signalWait<string>('go'),
    stop: ctx.signalWait<string>('stop'),
    late: ctx.timer('1h'),
  });
  const next = await ctx.waitForSignal<string>('stop');
  return { first, next };
};

describe('WorkflowContext.waitForAny (thin worker)', () => {
  it('emits one waitAny command with every condition and suspends', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async (ctx) =>
      ctx.waitForAny('race', {
        go: ctx.signalWait('go'),
        late: ctx.timer('2h'),
        at: ctx.timer({ until: 5000 }),
        kid: ctx.childWait('child-1'),
      }),
    );
    const d = await wf.processTask(task());
    expect(d.status).toBe('continue');
    expect(d.commands).toEqual([
      {
        kind: 'waitAny',
        seq: 0,
        name: 'race',
        conditions: [
          { key: 'go', kind: 'signal', signal: 'go' },
          { key: 'late', kind: 'timer', ms: 7_200_000 },
          { key: 'at', kind: 'timer', until: 5000 },
          { key: 'kid', kind: 'child', childId: 'child-1' },
        ],
      },
    ]);
  });

  it('replays the journaled winner, and re-raises a failed child', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async (ctx) => {
      try {
        return await ctx.waitForAny('race', { go: ctx.signalWait('go') });
      } catch (err) {
        return { caught: (err as Error).message };
      }
    });
    const ok = await wf.processTask(
      task({ history: [{ seq: 0, kind: 'any', name: 'race', output: { key: 'go', value: 1 } }] }),
    );
    expect(ok.output).toEqual({ key: 'go', value: 1 });
    const failed = await wf.processTask(
      task({
        history: [
          { seq: 0, kind: 'any', name: 'race', output: { key: 'kid' }, error: { message: 'boom' } },
        ],
      }),
    );
    expect(failed.output).toEqual({ caught: 'boom' });
  });

  it('fails a replay that reaches the wait under another name', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async (ctx) => ctx.waitForAny('renamed', { go: ctx.signalWait('go') }));
    const d = await wf.processTask(
      task({ history: [{ seq: 0, kind: 'any', name: 'race', output: { key: 'go' } }] }),
    );
    expect(d.status).toBe('failed');
    expect(d.error?.message).toMatch(/non-?determin/i);
  });
});

describe('waitForAny across the remote protocol (engine + thin worker)', () => {
  function remote() {
    const store = new InMemoryStateStore();
    let now = Date.parse('2026-11-07T00:00:00.000Z');
    const engine = new WorkflowEngine({ store, clock: () => now });
    const worker = new WorkflowWorker();
    worker.register('race', race);
    const executor: WorkflowExecutor = {
      advance: (run, history, pendingSignals) =>
        worker.processTask(
          task({
            runId: run.id,
            workflow: run.workflow,
            input: run.input,
            history,
            ...(pendingSignals ? { pendingSignals } : {}),
          }),
        ),
    };
    engine.registerRemote('race', '1', { group: 'wf', executor });
    return {
      engine,
      store,
      advance: (ms: number) => {
        now += ms;
        return now;
      },
    };
  }
  /** Wait until the run reaches `status` (or 2s pass), past the engine's macrotask re-drives. */
  const settle = async (engine: WorkflowEngine, id: string, status = 'suspended') => {
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const run = await engine.getRun(id);
      if (run?.status === status) return run;
    }
    return engine.getRun(id);
  };

  it('a signal wins; a losing signal sent later is buffered for the next wait', async () => {
    const { engine } = remote();
    await engine.start('race', {}, 'r1');
    expect((await settle(engine, 'r1'))?.status).toBe('suspended');
    await engine.signal('go', 'G');
    await settle(engine, 'r1');
    await engine.signal('stop', 'S');
    const run = await settle(engine, 'r1', 'completed');
    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ first: { key: 'go', value: 'G' }, next: 'S' });
  });

  it('a timer wins when nothing else happens', async () => {
    const { engine, advance } = remote();
    await engine.start('race', {}, 'r1');
    await settle(engine, 'r1');
    await engine.resumeDueTimers(advance(3_600_000));
    await settle(engine, 'r1');
    await engine.signal('stop', 'S');
    const run = await settle(engine, 'r1', 'completed');
    expect(run?.output).toEqual({ first: { key: 'late', value: null }, next: 'S' });
  });

  it('a signal buffered before the wait resolves it at once; the other stays for later', async () => {
    const { engine } = remote();
    await engine.signal('stop', 'early-stop');
    await engine.signal('go', 'early-go');
    await engine.start('race', {}, 'r1');
    await settle(engine, 'r1');
    // `stop` was sent first, so it won; `go` stayed buffered; the next wait on `stop` still waits.
    expect((await engine.getRun('r1'))?.status).toBe('suspended');
    await engine.signal('stop', 'S');
    const run = await settle(engine, 'r1', 'completed');
    expect(run?.output).toEqual({ first: { key: 'stop', value: 'early-stop' }, next: 'S' });
  });
});
