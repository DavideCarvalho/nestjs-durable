import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  InMemoryStateStore,
  type WorkflowDecision,
  WorkflowEngine,
  type WorkflowExecutor,
} from '@dudousxd/nestjs-durable-core';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Cross-language: the engine drives a PYTHON workflow (`clients/python`, `process_workflow_task`)
 * that calls `ctx.wait_for_any`. Each turn's task and decision cross a process boundary as the JSON
 * wire format; a line-per-message stdio bridge stands in for the broker. Skipped without `python3`.
 */
const pythonRoot = fileURLToPath(new URL('../../../clients/python', import.meta.url));
const script = fileURLToPath(
  new URL('./__fixtures__/python_wait_any_workflow.py', import.meta.url),
);

function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let python: ChildProcessWithoutNullStreams | undefined;
afterEach(() => {
  python?.kill();
  python = undefined;
});

function boot() {
  python = spawn('python3', ['-I', script, pythonRoot]);
  const child = python;
  const pending: Array<(d: WorkflowDecision) => void> = [];
  createInterface({ input: child.stdout }).on('line', (line) =>
    pending.shift()?.(JSON.parse(line) as WorkflowDecision),
  );
  // One turn at a time: the bridge answers in order.
  let chain = Promise.resolve();
  const executor: WorkflowExecutor = {
    advance: (run, history, pendingSignals) => {
      const turn = chain.then(
        () =>
          new Promise<WorkflowDecision>((resolve) => {
            pending.push(resolve);
            child.stdin.write(
              `${JSON.stringify({
                taskId: `t-${Math.random()}`,
                runId: run.id,
                workflow: run.workflow,
                workflowVersion: run.workflowVersion,
                input: run.input,
                history,
                pendingSignals: pendingSignals ?? [],
                group: 'py',
                attempt: 1,
              })}\n`,
            );
          }),
      );
      chain = turn.then(() => undefined);
      return turn;
    },
  };
  const store = new InMemoryStateStore();
  let now = Date.parse('2026-11-07T00:00:00.000Z');
  const engine = new WorkflowEngine({ store, clock: () => now });
  engine.registerRemote('race', '1', { group: 'py', executor });
  return {
    engine,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

async function settled(engine: WorkflowEngine, id: string, status: string) {
  for (let i = 0; i < 400; i++) {
    const run = await engine.getRun(id);
    if (run?.status === status) return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  return engine.getRun(id);
}

describe.runIf(hasPython())('waitForAny with a Python workflow over the wire', () => {
  it('a signal wins, and a losing signal sent later reaches the next wait', async () => {
    const { engine } = boot();
    await engine.start('race', {}, 'r1');
    expect((await settled(engine, 'r1', 'suspended'))?.status).toBe('suspended');
    await engine.signal('go', 'G');
    await new Promise((r) => setTimeout(r, 50));
    await settled(engine, 'r1', 'suspended');
    await engine.signal('stop', 'S');
    const run = await settled(engine, 'r1', 'completed');
    expect(run?.output).toEqual({ first: { key: 'go', value: 'G' }, next: 'S' });
  });

  it('a timer wins when nothing else happens', async () => {
    const { engine, advance } = boot();
    await engine.start('race', {}, 'r1');
    await settled(engine, 'r1', 'suspended');
    await engine.resumeDueTimers(advance(3_600_000));
    await new Promise((r) => setTimeout(r, 50));
    await settled(engine, 'r1', 'suspended');
    await engine.signal('stop', 'S');
    const run = await settled(engine, 'r1', 'completed');
    expect(run?.output).toEqual({ first: { key: 'late', value: null }, next: 'S' });
  });
});
